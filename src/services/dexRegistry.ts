import { AbstractDexClient } from './abstractDexClient';
import { BingxClient } from './bingx/bingxClient';
import { BitgetClient } from './bitget/bitgetClient';
import { BybitClient } from './bybit/bybitClient';
import { KrakenClient } from './kraken/krakenClient';
import { NexoClient } from './nexo/nexoClient';
import { AsterClient } from './aster/asterClient';
import { DydxV4Client } from './dydx_v4/dydxV4Client';
import { HyperLiquidClient } from './hyperliquid/hyperliquidClient';
import { ApexClient } from './apex/apexClient';
import { DriftClient } from './drift/driftClient';
import { MarsClient } from './mars/marsClient';
import { LighterClient } from './lighter/lighterClient';

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
		this.registeredDexs.set('drift', new DriftClient());
		this.registeredDexs.set('nexo', new NexoClient());
		this.registeredDexs.set('aster', new AsterClient());
		this.registeredDexs.set('mars', new MarsClient());
		this.registeredDexs.set('apex', new ApexClient());
		this.registeredDexs.set('lighter', new LighterClient());

	}

	getDex(dexKey: string): AbstractDexClient | undefined {
		return this.registeredDexs.get(dexKey);
	}


	getAllDexKeys(): string[] {
		return Array.from(this.registeredDexs.keys());
	}
}
