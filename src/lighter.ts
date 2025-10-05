// API Options
export interface ApiOptions {
  apiKey: string;
  apiSecret: string;
  accountIndex: number;
  apiKeyIndex: number;
  baseUrl?: string;
}

// Balance
export interface Balance {
  asset: string;
  walletBalance: number;
  availableBalance: number;
  unrealizedProfit: number;
  marginBalance: number;
}

// Position
export interface Position {
  symbol: string;
  positionSide: string;
  entryPrice: number;
  markPrice: number;
  positionAmt: number;
  leverage: number;
  unrealizedProfit: number;
  marginType: string;
  isolatedMargin?: number;
  updateTime: number;
}

// Order
export interface Order {
  orderId: string;
  symbol: string;
  status: "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "EXPIRED";
  side: "BUY" | "SELL";
  type: string;
  price: number;
  origQty: number;
  executedQty: number;
  updateTime: number;
}

// Order Types
export type OrderSide = "BUY" | "SELL";
export type PositionSide = "LONG" | "SHORT";
export type OrderType = "LIMIT" | "MARKET";
export type TimeInForce = "GTC" | "IOC" | "FOK";

// Place Order Parameters
export interface PlaceOrderParams {
  symbol: string;
  side: OrderSide;
  positionSide?: PositionSide;
  type: OrderType;
  quantity: number;
  price?: number;
  timeInForce?: TimeInForce;
  reduceOnly?: boolean;
}

// Order Response
export interface OrderResponse {
  orderId: string;
  symbol: string;
  status: "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED";
  side: OrderSide;
  type: OrderType;
  price: number;
  origQty: number;
  executedQty: number;
  updateTime: number;
}

// Account Info
export interface AccountInfo {
  accountIndex: number;
  l1Address: string;
  balance: number;
  availableBalance: number;
  positions: Position[];
}

// Next Nonce
export interface NextNonce {
  nonce: number;
}

// Fill
export interface Fill {
  tradeId: string;
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  quantity: number;
  commission: number;
  commissionAsset: string;
  timestamp: number;
  isMaker: boolean;
}

// PnL Entry
export interface PnLEntry {
  symbol: string;
  realizedPnl: number;
  unrealizedPnl: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  side: "LONG" | "SHORT";
  openTime: number;
  closeTime: number;
  commission: number;
}

// Symbol Info (Internal)
export type SymbolInfo = {
  symbol: string;
  pricePrecision: number;
  quantityPrecision: number;
  filters: any[];
};
