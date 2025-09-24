// types.ts

export interface AccountBalance {
  asset: string;          // z.B. "USDT"
  balance: number;        // Gesamtsaldo
  available: number;      // verfügbar für Orders
  frozen: number;         // gebundene Margin
}

export type OrderSide = "buy" | "sell";
export type OrderType = "limit" | "market";

export interface Order {
  id: string;
  market: string;
  side: OrderSide;
  type: OrderType;
  size: number;
  price?: number;         // optional für Market Orders
  filledSize: number;
  status: "open" | "filled" | "canceled";
  timestamp: string;
}

export interface Position {
  id: string;
  market: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  margin: number;
  leverage: number;
  liquidationPrice?: number;
  timestamp: string;
}

export interface OpenPosition extends Position {
  isOpen: boolean; // true, wenn Position aktiv ist
}

export interface MarketData {
  market: string;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  openInterest: number;
  timestamp: string;
}
