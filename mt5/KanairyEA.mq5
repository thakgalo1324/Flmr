//+------------------------------------------------------------------+
//| KanairyEA.mq5  (v2, the one EA for everyone)                      |
//| Native tick scalper for XAUUSD. It reacts to every tick inside   |
//| MT5, so it is fast. Once a second it talks to the Kanairy server |
//| on this VPS: the app's Start button turns trading on or off, and |
//| trades are reported back to the app.                             |
//| In the Strategy Tester it runs on its own (no server needed).    |
//+------------------------------------------------------------------+
#property strict
#property version   "2.00"
#property description "Kanairy tick scalper. Start and stop it from the Kanairy app."
#include <Trade/Trade.mqh>

//--- connection (the server fills these in when it launches MT5)
input string InpToken     = "";            // EA key printed by the Kanairy server
input string InpHost      = "127.0.0.1";   // Bridge address
input int    InpPort      = 80;            // Bridge port
input long   InpMagic     = 550002;        // Magic number
input bool   InpAllowLive = false;         // Allow trading on a REAL account

//--- trading
input double Lots          = 0.01;   // Lot size
input int    MaxSpreadPts  = 30;     // No trades when the spread is wider (points; 100 points = $1.00)
input int    WindowTicks   = 10;     // Ticks that make one momentum burst
input int    MaxWindowMs   = 1500;   // The burst must happen inside this time
input int    MinMovePts    = 30;     // Net move over the window (points)
input int    ConsistPct    = 70;     // % of tick steps that must go the same way
input int    TpPts         = 70;     // Take profit (points)
input int    SlPts         = 45;     // Stop loss (points)
input int    MaxHoldSec    = 25;     // Close after this many seconds
input int    FailExitPts   = 25;     // Close early if price goes this far against the trade
input int    CooldownMs    = 2000;   // Pause after a trade closes
input int    MaxOpen       = 1;      // Trades open at once
input int    MaxTradesDay  = 300;    // Stop for the day after this many trades
input double MaxDayLossUsd = 30.0;   // Stop for the day when down this much (0 = off)
input int    StartHour     = 7;      // Server hour to start (0-23)
input int    EndHour       = 20;     // Server hour to stop (0-23)
input int    Deviation     = 20;     // Max slippage (points)

CTrade trade;
double g_mid[];
long   g_ms[];
int    g_n = 0, g_head = 0, g_cap = 64;
int    g_dayKey = -1, g_tradesToday = 0;
double g_dayStartEq = 0;
ulong  g_lastCloseMs = 0;
bool   g_stoppedToday = false;
bool   g_run = false, g_tester = false;
ulong  g_lastOk = 0;
string g_status = "starting", g_ev = "";
int    g_evN = 0;

string Base() { return InpPort == 80 ? "http://" + InpHost : "http://" + InpHost + ":" + IntegerToString(InpPort); }

//--- HTTP --------------------------------------------------------------
bool Post(const string path, const string body, string &reply)
{
   char data[], res[];
   string rh;
   int n = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(n > 0) ArrayResize(data, n - 1);
   string headers = "Content-Type: application/json\r\nX-Token: " + InpToken + "\r\n";
   ResetLastError();
   int code = WebRequest("POST", Base() + path, headers, 2000, data, res, rh);
   if(code == -1)
   {
      int e = GetLastError();
      if(e == 4014 || e == 4060) g_status = "Allow " + Base() + " in Tools > Options > Expert Advisors > WebRequest";
      else g_status = "server offline (error " + IntegerToString(e) + ")";
      return false;
   }
   reply = CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8);
   if(code == 401) { g_status = "wrong key"; return false; }
   if(code != 200) { g_status = "server error " + IntegerToString(code); return false; }
   return true;
}

bool Mine(const ulong ticket)
{
   if(!PositionSelectByTicket(ticket)) return false;
   return PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == InpMagic;
}

int CountMine()
{
   int c = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t != 0 && Mine(t)) c++;
   }
   return c;
}

void CloseAllMine()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0 || !Mine(t)) continue;
      if(trade.PositionClose(t)) g_lastCloseMs = (ulong)GetTickCount64();
   }
}

double NormLots(double l)
{
   double mn = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN), mx = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX), st = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(st <= 0) st = 0.01;
   l = MathFloor(l / st + 1e-9) * st;
   l = MathMax(mn, MathMin(mx, l));
   return NormalizeDouble(l, 2);
}

//--- events are queued and sent from the timer, so a trade never waits for the network
void QueueEvent(const string k, const string side, const double lots, const double price, const double profit)
{
   if(g_tester || g_evN > 200) return;
   if(g_evN > 0) g_ev += ",";
   g_ev += StringFormat("{\"k\":\"%s\",\"side\":\"%s\",\"lots\":%.2f,\"price\":%s,\"profit\":%.2f}", k, side, lots, DoubleToString(price, _Digits), profit);
   g_evN++;
}

void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
   if(!HistoryDealSelect(trans.deal)) return;
   if(HistoryDealGetInteger(trans.deal, DEAL_MAGIC) != InpMagic || HistoryDealGetString(trans.deal, DEAL_SYMBOL) != _Symbol) return;
   long entry = HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
   long type  = HistoryDealGetInteger(trans.deal, DEAL_TYPE);
   double vol = HistoryDealGetDouble(trans.deal, DEAL_VOLUME), px = HistoryDealGetDouble(trans.deal, DEAL_PRICE);
   if(entry == DEAL_ENTRY_IN)
      QueueEvent("open", type == DEAL_TYPE_BUY ? "buy" : "sell", vol, px, 0);
   else if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
   {
      double pr = HistoryDealGetDouble(trans.deal, DEAL_PROFIT) + HistoryDealGetDouble(trans.deal, DEAL_SWAP) + HistoryDealGetDouble(trans.deal, DEAL_COMMISSION);
      QueueEvent("close", type == DEAL_TYPE_SELL ? "buy" : "sell", vol, px, pr);   // a sell deal closes a buy
      g_lastCloseMs = (ulong)GetTickCount64();
   }
}

string PositionsJson()
{
   string out = "[";
   bool first = true;
   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0 || !Mine(t)) continue;
      if(!first) out += ",";
      first = false;
      out += StringFormat("[%I64u,%d,%.2f,%s,%s,%s,%.2f]", t, (int)PositionGetInteger(POSITION_TYPE), PositionGetDouble(POSITION_VOLUME),
                          DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), _Digits), DoubleToString(PositionGetDouble(POSITION_SL), _Digits),
                          DoubleToString(PositionGetDouble(POSITION_TP), _Digits), PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP));
   }
   return out + "]";
}

//--- once a second: report to the server, learn whether to trade
void Sync()
{
   if(g_evN > 0)
   {
      string er;
      if(Post("/event", "{\"k\":\"batch\",\"list\":[" + g_ev + "]}", er)) { g_ev = ""; g_evN = 0; }
   }
   bool hedge = AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING;
   bool at = TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED);
   string body = StringFormat("{\"sym\":\"%s\",\"tf\":\"%s\",\"bid\":%s,\"ask\":%s,\"bal\":%.2f,\"eq\":%.2f,\"spread\":%d,\"hedge\":%s,\"cid\":\"%I64d\",\"at\":%s,\"st\":%I64d,\"pos\":%s}",
                              _Symbol, "TICK", DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_BID), _Digits), DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_ASK), _Digits),
                              AccountInfoDouble(ACCOUNT_BALANCE), AccountInfoDouble(ACCOUNT_EQUITY), (int)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD),
                              hedge ? "true" : "false", (long)ChartID(), at ? "true" : "false", (long)TimeCurrent(), PositionsJson());
   string reply;
   if(!Post("/sync", body, reply)) { if(GetTickCount64() - g_lastOk > 30000) g_run = false; return; }   // lost the server: stop opening new trades
   g_lastOk = GetTickCount64();
   if(StringFind(reply, "\"ignore\"") >= 0) { g_status = "ignored: wrong symbol or duplicate chart"; g_run = false; return; }
   g_run = StringFind(reply, "\"run\":true") >= 0;
   if(StringFind(reply, "\"a\":\"closeall\"") >= 0) CloseAllMine();
   g_status = !at ? "AutoTrading is OFF: click the Algo Trading button" : g_stoppedToday ? "stopped for today (limit reached)" : g_run ? "trading" : "ready, waiting for Start";
}

//--- tick logic ----------------------------------------------------------
void NewDayCheck()
{
   MqlDateTime d;
   TimeToStruct(TimeCurrent(), d);
   int key = d.year * 1000 + d.day_of_year;
   if(key != g_dayKey) { g_dayKey = key; g_tradesToday = 0; g_stoppedToday = false; g_dayStartEq = AccountInfoDouble(ACCOUNT_EQUITY); }
}

void ManageOpen(const MqlTick &tk)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0 || !Mine(t)) continue;
      long type = PositionGetInteger(POSITION_TYPE);
      double open = PositionGetDouble(POSITION_PRICE_OPEN);
      datetime ot = (datetime)PositionGetInteger(POSITION_TIME);
      double against = (type == POSITION_TYPE_BUY) ? (open - tk.bid) / _Point : (tk.ask - open) / _Point;
      if((TimeCurrent() - ot) >= MaxHoldSec || against >= FailExitPts)
         if(trade.PositionClose(t)) g_lastCloseMs = (ulong)GetTickCount64();
   }
}

bool Burst(int &dir)
{
   dir = 0;
   if(g_n < WindowTicks + 1) return false;
   int last = (g_head - 1 + g_cap) % g_cap;
   int first = (g_head - 1 - WindowTicks + g_cap * 2) % g_cap;
   if(g_ms[last] - g_ms[first] > MaxWindowMs) return false;
   double move = (g_mid[last] - g_mid[first]) / _Point;
   int up = 0, dn = 0;
   for(int k = 0; k < WindowTicks; k++)
   {
      int a = (first + k) % g_cap, b = (first + k + 1) % g_cap;
      if(g_mid[b] > g_mid[a]) up++;
      else if(g_mid[b] < g_mid[a]) dn++;
   }
   int moving = up + dn;
   if(moving < WindowTicks / 2) return false;
   if(move >= MinMovePts && up * 100 >= ConsistPct * moving) { dir = 1; return true; }
   if(move <= -MinMovePts && dn * 100 >= ConsistPct * moving) { dir = -1; return true; }
   return false;
}

int OnInit()
{
   g_tester = MQLInfoInteger(MQL_TESTER) != 0;
   if(!g_tester && StringLen(InpToken) < 8)
   {
      Print("[Kanairy] EA key is empty. Start MT5 from the Kanairy app so the server fills it in.");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL && !InpAllowLive)
   {
      Print("[Kanairy] REAL account detected. Set allowLive in the server config to trade it. Stopping.");
      return INIT_FAILED;
   }
   SymbolSelect(_Symbol, true);
   ArrayResize(g_mid, g_cap);
   ArrayResize(g_ms, g_cap);
   trade.SetExpertMagicNumber((ulong)InpMagic);
   trade.SetDeviationInPoints((ulong)Deviation);
   trade.SetTypeFillingBySymbol(_Symbol);
   g_dayStartEq = AccountInfoDouble(ACCOUNT_EQUITY);
   if(g_tester) { g_run = true; g_status = "tester"; }
   else EventSetTimer(1);
   g_lastOk = GetTickCount64();
   Print("[Kanairy] EA ready on ", _Symbol);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Comment("");
}

void OnTimer()
{
   Sync();
   Comment("KANAIRY  |  ", g_status, "\n", _Symbol, "  trades today: ", g_tradesToday);
}

void OnTick()
{
   MqlTick tk;
   if(!SymbolInfoTick(_Symbol, tk)) return;
   if(tk.bid <= 0 || tk.ask <= 0) return;
   NewDayCheck();

   g_mid[g_head] = (tk.bid + tk.ask) * 0.5;
   g_ms[g_head] = (long)tk.time_msc;
   if(g_ms[g_head] == 0) g_ms[g_head] = (long)tk.time * 1000;
   g_head = (g_head + 1) % g_cap;
   if(g_n < g_cap) g_n++;

   ManageOpen(tk);                       // exits always run, even when stopped

   if(!g_run || g_stoppedToday) return;
   if(MaxDayLossUsd > 0 && AccountInfoDouble(ACCOUNT_EQUITY) - g_dayStartEq <= -MaxDayLossUsd)
   { g_stoppedToday = true; Print("[Kanairy] Daily loss limit reached. Stopped for today."); return; }
   if(g_tradesToday >= MaxTradesDay) return;

   MqlDateTime d;
   TimeToStruct(TimeCurrent(), d);
   if(d.hour < StartHour || d.hour >= EndHour) return;

   double spreadPts = MathRound((tk.ask - tk.bid) / _Point);
   if(spreadPts > MaxSpreadPts) return;
   if(TpPts < spreadPts * 2.0) return;
   if(CountMine() >= MaxOpen) return;
   if(g_lastCloseMs > 0 && (ulong)GetTickCount64() - g_lastCloseMs < (ulong)CooldownMs) return;

   int dir;
   if(!Burst(dir)) return;

   bool ok;
   if(dir > 0) ok = trade.Buy(NormLots(Lots), _Symbol, tk.ask, tk.ask - SlPts * _Point, tk.ask + TpPts * _Point, "kt");
   else        ok = trade.Sell(NormLots(Lots), _Symbol, tk.bid, tk.bid + SlPts * _Point, tk.bid - TpPts * _Point, "kt");
   if(ok) { g_tradesToday++; g_n = 0; }
}
