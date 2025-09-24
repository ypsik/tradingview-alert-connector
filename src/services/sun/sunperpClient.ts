// sunperpClient.ts

import axios, { AxiosInstance } from "axios";
import { AccountBalance, Order, Position, OpenPosition, MarketData, OrderSide, OrderType } from "../../sun";

export class SunPerpClient {
  private api: AxiosInstance;

  constructor(private apiKey: string, private baseUrl: string = "https://api.sunperp.com") {
    this.api = axios.create({
      baseURL: this.baseUrl,
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      timeout: 5000
    });
  }

  /** Kontostände abrufen */
  async getAccountBalance(): Promise<AccountBalance[]> {
    const response = await this.api.get("/account/balance");
    return response.data;
  }

  /** Alle Positionen abrufen */
  async getPositions(): Promise<Position[]> {
    const response = await this.api.get("/positions");
    return response.data;
  }

  /** Offene Positionen filtern */
  async getOpenPositions(): Promise<OpenPosition[]> {
    const allPositions = await this.getPositions();
    const openPositions: OpenPosition[] = allPositions
      .filter(pos => pos.size > 0) // aktive Positionen haben Größe > 0
      .map(pos => ({ ...pos, isOpen: true }));
    return openPositions;
  }

  /** Marktinformationen abrufen */
  async getMarketData(market: string): Promise<MarketData> {
    const response = await this.api.get(`/market/${market}`);
    return response.data;
  }

  /** Order platzieren */
  async placeOrder(order: {
    market: string;
    side: OrderSide;
    type: OrderType;
    size: number;
    price?: number;
  }): Promise<Order> {
    const response = await this.api.post("/orders", order);
    return response.data;
  }

  /** Order stornieren */
  async cancelOrder(orderId: string): Promise<{ success: boolean }> {
    const response = await this.api.delete(`/orders/${orderId}`);
    return response.data;
  }

  /** Alle offenen Orders abrufen */
  async getOpenOrders(market?: string): Promise<Order[]> {
    const url = market ? `/orders?market=${market}` : "/orders";
    const response = await this.api.get(url);
    return response.data;
  }
}
