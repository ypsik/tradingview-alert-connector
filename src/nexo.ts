// === Public ===
export interface Instrument {
  instrument: string;
  baseCurrency: string;
  quoteCurrency: string;
  type: 'spot' | 'perpetual';
  tickSize: string;
  quantityIncrement: string;
  minQuantity: string;
  marginTrading: boolean;
  status: 'online' | 'offline';
}

export interface Ticker {
  instrument: string;
  lastPrice: string;
  markPrice: string;
  indexPrice: string;
  bid: string;
  ask: string;
  priceChangePct: string;
  volume24h: string;
  high24h: string;
  low24h: string;
}

export interface Trade {
  tradeId: string;
  price: string;
  quantity: string;
  timestamp: number;
  side: 'buy' | 'sell';
}

export interface FundingInfo {
  instrument: string;
  nextFundingRate: string;
  nextFundingTime: number;
}

// === Account / Balances ===
export interface AccountBalance {
  currency: string;
  total: string;
  available: string;
  reserved: string;
}

// === Spot Position ===
export interface SpotPosition {
  instrument: string;
  quantity: string;
  averagePrice: string;
  side: 'buy' | 'sell';
}

// === Futures Position ===
export interface FuturesPosition {
  instrument: string;
  positionSide: 'long' | 'short';
  quantity: string;
  entryPrice: string;
  leverage: string;
  marginMode: 'cross' | 'isolated';
  unrealizedPnl: string;
  liquidationPrice: string;
  markPrice: string;
  timestamp: number;
}

// === Orders ===
export interface FuturesOrder {
  instrument: string;
  type: 'limit' | 'market';
  positionAction: 'open' | 'close';
  positionSide: 'short' | 'long';
  quantity: string;
  price?: string;
  postOnly?: boolean;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export interface SpotOrder {
  instrument: string;
  type: 'limit' | 'market';
  side: 'buy' | 'sell';
  quantity: string;
  price?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}
