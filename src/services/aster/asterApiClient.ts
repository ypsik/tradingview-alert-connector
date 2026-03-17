import axios, { AxiosInstance } from "axios";
import { ethers } from "ethers";
import { Position } from '../../aster';


interface ApiOptions {
  apiKey: string;      // Deine Main-Wallet Adresse (user)
  apiSecret: string;   // Der Private Key aus dem Screenshot
  baseUrl?: string;
  recvWindow?: number;
  signer?: string;     // Die API-Wallet Adresse aus dem Screenshot
}

export interface Balance {
  asset: string;
  walletBalance: number;
  availableBalance: number;
  unrealizedProfit: number;
  marginBalance: number;
}

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
  price?: number;
  timeInForce?: TimeInForce;
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
  private signer: string;

  constructor(options: ApiOptions) {
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.baseUrl = options.baseUrl || "https://fapi3.asterdex.com";
    this.recvWindow = options.recvWindow || 5000;
    this.signer = options.signer || "";

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
    });
  }

  private async initTimeOffset() {
    const res = await axios.get(`${this.baseUrl}/fapi/v3/time`);
    const serverTime = res.data.serverTime;
    this.timeOffset = serverTime - Date.now();
  }

  private async sign(totalParams: string): Promise<string> {
    const wallet = new ethers.Wallet(this.apiSecret);
    const domain = {
      name: "AsterSignTransaction",
      version: "1",
      chainId: 1666,
      verifyingContract: "0x0000000000000000000000000000000000000000"
    };
    const types = {
      Message: [{ name: "msg", type: "string" }]
    };
    const value = { msg: totalParams };
    return await wallet._signTypedData(domain, types, value);
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    endpoint: string,
    params: Record<string, any> = {},
  ): Promise<T> {
    const now = Date.now();
    params.nonce = (BigInt(now) * BigInt(1000)).toString();
    params.user = this.apiKey;
    params.signer = this.signer;

    const sortedKeys = Object.keys(params).sort();
    const sortedParams = new URLSearchParams();
    sortedKeys.forEach(key => {
      sortedParams.append(key, params[key].toString());
    });

    const query = sortedParams.toString();
    const signature = await this.sign(query);

    if (method === "GET" || method === "DELETE") {
      const url = `${endpoint}?${query}&signature=${signature}`;
      const res = await this.http.request<T>({ method, url });
      return res.data;
    } else {
      const bodyString = `${query}&signature=${signature}`;
      const res = await this.http.post<T>(endpoint, bodyString, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      return res.data;
    }
  }

  public async getAccountBalances(): Promise<Balance[]> {
    return await this.request<Balance[]>("GET", "/fapi/v3/balance");
  }

  private async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    if (!this.symbolCache[symbol]) {
      const data = await this.request<{ symbols: SymbolInfo[] }>("GET", "/fapi/v3/exchangeInfo");
      const info = data.symbols.find(s => s.symbol === symbol);
      if (!info) throw new Error(`Symbol ${symbol} not found`);
      this.symbolCache[symbol] = info;
    }
    return this.symbolCache[symbol];
  }

  public async getOpenOrders(symbol?: string) {
    return this.request("GET", "/fapi/v3/openOrders", symbol ? { symbol } : {});
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
    return this.placeOrderInternal({ ...params, price, quantity });
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
      body.reduceOnly = params.reduceOnly.toString();
    }
    const data = await this.request<any>("POST", "/fapi/v3/order", body);
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
    const data = await this.request<any>("GET", "/fapi/v3/order", { symbol, orderId });
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
    return this.request("DELETE", "/fapi/v3/order", { symbol, orderId });
  }

  public async getPositions(): Promise<Position[]> {
    const data = await this.request<any[]>("GET", "/fapi/v3/positionRisk");
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
    })).filter((p) => p.positionAmt !== 0);
  }
}

export default AsterClient;
