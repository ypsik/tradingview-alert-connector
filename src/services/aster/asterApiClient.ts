import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import { Position } from '../../aster';


interface ApiOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  recvWindow?: number;
}

export interface Balance {
  asset: string;
  walletBalance: number;
  availableBalance: number;
  unrealizedProfit: number;
  marginBalance: number;
}

// ---- Order Typ ----
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

export type OrderSide = "BUY" | "SELL";
export type PositionSide = "LONG" | "SHORT";
export type OrderType = "LIMIT" | "MARKET";
export type TimeInForce = "GTC" | "IOC" | "FOK";

export interface PlaceOrderParams {
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  type: OrderType;
  quantity: number;
  price?: number;              // nur bei LIMIT
  timeInForce?: TimeInForce;   // nur bei LIMIT
  reduceOnly?: boolean;
}

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

type SymbolInfo = {
  symbol: string;
  pricePrecision: number;
  quantityPrecision: number;
  filters: any[];
};

export class AsterClient {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  private recvWindow: number;
  private http: AxiosInstance;
  private symbolCache: Record<string, SymbolInfo> = {};
  private timeOffset: number = 0;

  constructor(options: ApiOptions) {
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.baseUrl = options.baseUrl || "https://fapi.asterdex.com";
    this.recvWindow = options.recvWindow || 5000;

    this.http = axios.create({
      baseURL: this.baseUrl,
      headers: { "X-MBX-APIKEY": this.apiKey },
      timeout: 10000,
    });
//    this.initTimeOffset();
  }

  private async initTimeOffset() {
    const res = await axios.get(`${this.baseUrl}/fapi/v1/time`);
    const serverTime = res.data.serverTime;
    this.timeOffset = serverTime - Date.now();
    console.log("⏱️ Zeit-Offset:", this.timeOffset, "ms");
  }

  private sign(totalParams: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(totalParams).digest("hex");
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    endpoint: string,
    params: Record<string, any> = {},
  ): Promise<T> {
    const timestamp = Date.now();
    params.timestamp = timestamp;
    params.recvWindow = this.recvWindow;

    const query = new URLSearchParams(params).toString();
    const signature = this.sign(query);

    if (method === "GET" || method === "DELETE") {
      const url = `${endpoint}?${query}&signature=${signature}`;
      const res = await this.http.request<T>({
	      method,
	      url,
	    });
      return res.data;
    } else {
      // POST → Parameter im Body als form-data senden
      const bodyString = `${query}&signature=${signature}`;
      const res = await this.http.post<T>(endpoint, bodyString, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      return res.data;
    }
  }

 // Balance

  public async getAccountBalances(): Promise<Balance[]> {
    const data = await this.request<any>("GET", "fapi/v2/balance");
    return data;
  }

  // Symbol info
  private async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    if (!this.symbolCache[symbol]) {
      const data = await this.request<{ symbols: SymbolInfo[] }>("GET", "/fapi/v1/exchangeInfo");
      const info = data.symbols.find(s => s.symbol === symbol);
      if (!info) throw new Error(`Symbol ${symbol} not found`);
      this.symbolCache[symbol] = info;
    }
    return this.symbolCache[symbol];
  }
  // Orders
  public async getOpenOrders(symbol?: string) {
    return this.request("GET", "/fapi/v1/orders", symbol ? { symbol } : {});
  }

  private fixStepSize(value: number, stepSize: string) {
    const decimals = stepSize.indexOf("1") - 1;
    return parseFloat(value.toFixed(Math.max(0, decimals)));
  }

  private async normalizeOrder(symbol: string, price?: number, quantity?: number) {
    const info = await this.getSymbolInfo(symbol);

    let fixedPrice: number | undefined;
    let fixedQty: number | undefined;

    if (price !== undefined) {
      const priceFilter = info.filters.find(f => f.filterType === "PRICE_FILTER");
      const tickSize = priceFilter?.tickSize ?? "0.1";
      fixedPrice = this.fixStepSize(price, tickSize);
    }

    if (quantity !== undefined) {
      const lotSize = info.filters.find(f => f.filterType === "LOT_SIZE");
      const stepSize = lotSize?.stepSize ?? "0.001";
      fixedQty = this.fixStepSize(quantity, stepSize);
    }

    return { price: fixedPrice, quantity: fixedQty };
  }

  public async placeOrder(params: PlaceOrderParams): Promise<OrderResponse> {
  const { price, quantity } = await this.normalizeOrder(params.symbol, params.price, params.quantity);

  return this.placeOrderInternal({
    ...params,
    price,
    quantity,
  });
}
  
  private async placeOrderInternal(params: PlaceOrderParams): Promise<OrderResponse> {
    const body: any = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      quantity: params.quantity.toString(),
    };

    if (params.type === "LIMIT") {
      body.price = params.price?.toString();
      body.timeInForce = params.timeInForce ?? "GTC";
    }

    if (params.reduceOnly !== undefined) {
      body.reduceOnly = params.reduceOnly;
    }

    const data = await this.request<any>("POST", "/fapi/v1/order", body);

    return {
      orderId: data.orderId,
      symbol: data.symbol,
      status: data.status,
      side: data.side,
      type: data.type,
      price: parseFloat(data.price),
      origQty: parseFloat(data.origQty),
      executedQty: parseFloat(data.executedQty),
      updateTime: data.updateTime,
    };
  }

  public async getOrderDetails(symbol: string, orderId: string): Promise<Order> {
    const data = await this.request<any>("GET", "/fapi/v1/order", { symbol, orderId });

    return {
      orderId: data.orderId,
      symbol: data.symbol,
      status: data.status,
      side: data.side,
      type: data.type,
      price: parseFloat(data.price),
      origQty: parseFloat(data.origQty),
      executedQty: parseFloat(data.executedQty),
      updateTime: data.updateTime,
    };
  }

  public async cancelOrder(symbol: string, orderId: string) {
    return this.request("DELETE", "/fapi/v1/order", { symbol, orderId });
  }

  // Positions
  public async getPositions(): Promise<Position[]> {
    const data = await this.request<any[]>("GET", "/fapi/v2/positionRisk");
    return data.map((p) => ({
      symbol: p.symbol,
      positionSide: p.positionSide,
      entryPrice: parseFloat(p.entryPrice),
      markPrice: parseFloat(p.markPrice),
      positionAmt: parseFloat(p.positionAmt),
      leverage: parseInt(p.leverage),
      unrealizedProfit: parseFloat(p.unrealizedProfit),
      marginType: p.marginType,
      isolatedMargin: p.isolatedMargin ? parseFloat(p.isolatedMargin) : undefined,
      updateTime: p.updateTime,
    }));
  }
}

export default AsterClient;

