import { AbstractDexClient } from './abstractDexClient';
import { BingxClient } from './bingx/bingxClient';
import { BitgetClient } from './bitget/bitgetClient';
import { BybitClient } from './bybit/bybitClient';
import { KrakenClient } from './kraken/krakenClient';
import { DydxV4Client } from './dydx_v4/dydxV4Client';
import { HyperLiquidClient } from './hyperliquid/hyperliquidClient';

export class DexRegistry {
	private registeredDexs: Map<string, AbstractDexClient>;

	constructor() {
		this.registeredDexs = new Map();
		this.registeredDexs.set('dydxv4', new DydxV4Client());
		this.registeredDexs.set('hyperliquid', new HyperLiquidClient());
		this.registeredDexs.set('bybit', new BybitClient());
		this.registeredDexs.set('bitget', new BitgetClient());
		this.registeredDexs.set('bingx', new BingxClient());
		this.registeredDexs.set('kraken', new KrakenClient());
	}

	getDex(dexKey: string): AbstractDexClient {
		return this.registeredDexs.get(dexKey);
	}

	getAllDexKeys(): string[] {
		return Array.from(this.registeredDexs.keys());
	}
}
