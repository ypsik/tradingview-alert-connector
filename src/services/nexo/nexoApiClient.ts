import axios from 'axios';
import crypto from 'crypto';
import {
  Instrument,
  Ticker,
  Trade,
  FundingInfo,
  AccountBalance,
  SpotPosition,
  FuturesPosition,
  SpotOrder,
  FuturesOrder,
} from '../../nexo';

const BASE_URL = 'https://api.pro.nexo.com/rest';

export default class NexoApiClient {
  private apiKey: string;
  private apiSecret: string;

  constructor(apiKey: string, apiSecret: string) {
    if (!apiKey || !apiSecret) {
      throw new Error('API key and secret are required');
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  private getTimestamp(): number {
    return Date.now();
  }

  private signMessage(
    timestamp: number,
    method: string,
    path: string,
    body = ''
  ): string {
    const message = `${timestamp}${method}${path}${body}`;
    return crypto.createHmac('sha256', this.apiSecret).update(message).digest('hex');
  }

  private async request<T>(
    method: 'get' | 'post' | 'delete',
    path: string,
    data: any = null,
    isPrivate = false
  ): Promise<T> {
    const timestamp = this.getTimestamp();
    const url = `${BASE_URL}${path}`;
    const body = data ? JSON.stringify(data) : '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (isPrivate) {
      const signature = this.signMessage(timestamp, method.toUpperCase(), path, body);
      headers['Nexo-API-Key'] = this.apiKey;
      headers['Nexo-Request-Timestamp'] = timestamp.toString();
      headers['Nexo-Signature'] = signature;
    }

    try {
      const response = await axios({
        url,
        method,
        headers,
        data: data || undefined,
      });
      return response.data as T;
    } catch (error: any) {
      throw error.response?.data || error.message;
    }
  }

  // === Public Spot ===
  async getInstruments(): Promise<{ data: Instrument[] }> {
    return this.request('get', '/public/instruments');
  }

  async getOrderBook(instrument: string): Promise<any> {
    return this.request('get', `/public/orderbook?instrument=${instrument}`);
  }

  async getTicker(instrument: string): Promise<Ticker> {
    return this.request('get', `/public/ticker?instrument=${instrument}`);
  }

  async getTrades(instrument: string): Promise<{ data: Trade[] }> {
    return this.request('get', `/public/trades?instrument=${instrument}`);
  }

  // === Private Spot ===
  async getAccountBalances(): Promise<{ balances: AccountBalance[] }> {
    return this.request('get', '/account/balances', null, true);
  }

  async getAccountPositions(): Promise<{ positions: SpotPosition[] }> {
    return this.request('get', '/account/positions', null, true);
  }

  async getOpenOrders(): Promise<any> {
    return this.request('get', '/orders', null, true);
  }

  async placeOrder(order: SpotOrder): Promise<any> {
    return this.request('post', '/orders', order, true);
  }

  async cancelOrder(orderId: string): Promise<any> {
    return this.request('delete', `/orders/${orderId}`, null, true);
  }

  // === Public Futures ===
  async getFuturesInstruments(): Promise<{ data: Instrument[] }> {
    return this.request('get', '/public/futures/instruments');
  }

  async getFuturesOrderBook(instrument: string): Promise<any> {
    return this.request('get', `/public/futures/orderbook?instrument=${instrument}`);
  }

  async getFuturesTicker(instrument: string): Promise<Ticker> {
    return this.request('get', `/public/futures/ticker?instrument=${instrument}`);
  }

  async getFuturesTrades(instrument: string): Promise<{ data: Trade[] }> {
    return this.request('get', `/public/futures/trades?instrument=${instrument}`);
  }

  async getFuturesFunding(instrument: string): Promise<FundingInfo> {
    return this.request('get', `/public/futures/funding?instrument=${instrument}`);
  }

  // === Private Futures ===
  async getFuturesAccountBalances(): Promise<{ balances: AccountBalance[] }> {
    return this.request('get', '/futures/account/balances', null, true);
  }

  async getFuturesAccountPositions(): Promise<{ positions: FuturesPosition[] }> {
    return this.request('get', '/futures/account/positions', null, true);
  }

  async getFuturesOpenOrders(): Promise<any> {
    return this.request('get', '/futures/orders', null, true);
  }

  async placeFuturesOrder(order: FuturesOrder): Promise<any> {
    return this.request('post', '/futures/orders', order, true);
  }

  async cancelFuturesOrder(orderId: string): Promise<any> {
    return this.request('delete', `/futures/orders/${orderId}`, null, true);
  }

  async getFuturesPositions(): Promise<{ positions: FuturesPosition[] }> {
    return this.request('get', '/futures/positions', null, true);
  }

  async adjustFuturesPositionMargin(data: any): Promise<any> {
    return this.request('post', '/futures/position/margin', data, true);
  }
}
