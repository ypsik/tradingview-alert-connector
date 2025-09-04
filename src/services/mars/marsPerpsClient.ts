import * as dotenv from "dotenv";
dotenv.config();

import { DirectSecp256k1HdWallet, type OfflineSigner } from "@cosmjs/proto-signing";
import { SigningCosmWasmClient, CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { GasPrice, calculateFee } from "@cosmjs/stargate";
import { PositionsByAccountResponse, OpenPosition } from "../../mars";
import { EncodeObject } from "@cosmjs/proto-signing";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";

const CHAIN_ID = process.env.NEUTRON_CHAIN_ID!;
const ADDRESS_PROVIDER = process.env.MARS_ADDRESS_PROVIDER!;
const FEE_DENOM = process.env.FEE_DENOM ?? "untrn";
const GAS_PRICE = process.env.GAS_PRICE ?? `0.025${FEE_DENOM}`;

// ---------------- Types ----------------
type Decimal = string;
type Int128 = string;
type Uint128 = string;

type Action =
  | { execute_perp_order: { denom: string; order_size: Int128; reduce_only?: boolean | null } }
  | { create_trigger_order: { actions: Action[]; conditions: Condition[]; keeper_fee: Coin } }
  | { delete_trigger_order: { trigger_order_id: string } }
  | { lend: { denom: string; amount: "account_balance" | string } }
  | { reclaim: { denom: string; amount: { exact: string } } };
export type Condition =
  | {
      oracle_price: {
        comparison: "less_than" | "greater_than";
        denom: string;
        price: string;
      };
    }
  | {
      time: {
        timestamp: string; // wird als string ins Msg gepackt
      };
    };

interface Coin { amount: Uint128; denom: string; }

interface MarsAddressEntry {
  address_type: string;
  address: string;
}

interface MarsAddressListResponse {
  addresses: MarsAddressEntry[];
}

interface PerpsPositionsByAccountResp { data: { positions: { denom: string; size: Int128; entry_price: Decimal; current_price: Decimal; unrealized_pnl?: { pnl: Int128 } }[] } }
interface TriggerOrdersByAccountResp { data: { data: { order: { order_id: string; actions: Action[]; conditions: Condition[]; keeper_fee: Coin } }[] } }
interface CreditManagerConfigResp { keeper_fee_config: { min_fee: Coin } }

// ---------------- Client ----------------
export class marsPerpsClient {
  private signer!: OfflineSigner;
  private signingClient!: SigningCosmWasmClient;
  private queryClient!: CosmWasmClient;
  public sender!: string;
  private creditManagerAddr!: string;
  private perpsAddr!: string;
  private marketDecimalsCache: Record<string, number> = {};  
  private lastGasUsed: number | null = null;

  constructor(
    private readonly rpc: string,
    private readonly mnemonic: string,
    private readonly chainId: string = CHAIN_ID,
    private readonly addressProvider: string = ADDRESS_PROVIDER,
    private readonly gasPrice: string = GAS_PRICE,
  ) {}

  async init() {
    this.signer = await DirectSecp256k1HdWallet.fromMnemonic(this.mnemonic, { prefix: "neutron" });
    const accounts = await this.signer.getAccounts();
    this.sender = accounts[0].address;

    const gp = GasPrice.fromString(this.gasPrice);
    this.signingClient = await SigningCosmWasmClient.connectWithSigner(this.rpc, this.signer, { gasPrice: gp });
    this.queryClient = await CosmWasmClient.connect(this.rpc);
    await this.loadContracts();

    // Resolve addresses
   // const types = ["credit_manager", "perps"];

 //   const addrResp = await this.queryClient.queryContractSmart(this.addressProvider, { addresses: types }) as AddressProviderAddressesResp;
    
//    this.perpsAddr = await this.getContractAddress("perps");
//    this.creditManagerAddr = await this.getContractAddress("credit_manager");


    if (!this.creditManagerAddr || !this.perpsAddr) throw new Error("Failed to resolve credit_manager or perps addresses");
  }

  // Lädt Perps & CreditManager Adressen automatisch
  private async loadContracts() {
    // Variante 1: Query als Array
    let resp: MarsAddressListResponse | null = null;
    try {
      resp = await this.queryClient.queryContractSmart(this.addressProvider, {
        addresses: ["perps", "credit_manager"]
      }) as MarsAddressListResponse;
    } catch {}

    // Variante 2: Einzel-Abfragen
    if (!resp || !resp.addresses) {
      const perpsResp = await this.queryClient.queryContractSmart(this.addressProvider, { address: "perps" }) as { address: string; address_type: string };
      const creditResp = await this.queryClient.queryContractSmart(this.addressProvider, { address: "credit_manager" }) as { address: string; address_type: string };
      if (!perpsResp.address || !creditResp.address) throw new Error("Failed to fetch addresses from AddressProvider");
      this.perpsAddr = perpsResp.address;
      this.creditManagerAddr = creditResp.address;
      return;
    }
  }

  getAddress() { return this.sender; }

  /** Holt Market Decimals mit Cache */
  private async getMarketDecimals(denom: string): Promise<number> {
    if (this.marketDecimalsCache[denom]) return this.marketDecimalsCache[denom];

    // Fixwerte eintragen (per UI/Repo bestätigt)
    const fixedDecimals: Record<string, number> = {
      "perps/ubtc": 6,
      "perps/ueth": 6,
    };

    if (!fixedDecimals[denom]) throw new Error(`Market ${denom} hat keine Decimals definiert`);
    this.marketDecimalsCache[denom] = fixedDecimals[denom];
    return fixedDecimals[denom];
  }

  /** Konvertiert Int128 String in Number mit baseDecimals */
  private int128ToNumber(value: string, decimals: number): number {
    return parseFloat(value) / 10 ** decimals;
  }

  /** Prüft, ob ein Account existiert, erstellt ihn falls nicht */
  async ensureAccount(): Promise<string> {
    // Alle Vault-Positionen abfragen
    const accountsResp = await this.queryClient.queryContractSmart(this.creditManagerAddr, {  accounts: { owner: this.getAddress() } });
    const accounts: { id: string; kind: string }[] = accountsResp ?? [];
    let account = accounts.find(a => a.kind === "default");

    if (!account) {
      const createMsg = {
        create_credit_account: "default"
      };

      const result = await this.signingClient.execute(
        this.sender,
        this.creditManagerAddr,
        createMsg,
        "auto"
      );

      console.log("Credit Account erstellt:", result.transactionHash);

      // Nach Erstellung erneut abfragen
      const updatedAccountsResp = await this.queryClient.queryContractSmart(this.creditManagerAddr, {  accounts: { owner: this.getAddress() } });
      const updatedAccounts: { id: string; kind: string }[] = updatedAccountsResp ?? [];

      account = updatedAccounts.find(a => a.kind === "default");

      if (!account) throw new Error("Account konnte nach Erstellung nicht gefunden werden");
    }

    return account.id;
  }

  async getBalance(address: string, denom: string = "untrn") {
    if (!this.queryClient) throw new Error("Not connected");
    const balance = await this.queryClient.getBalance(address, denom);
    return balance; // { denom: "untrn", amount: "123456" }
  }

  // Positionen abfragen
  public async getOpenPositions(accountId: string): Promise<PositionsByAccountResponse> {
    const resp = await this.queryClient.queryContractSmart(this.perpsAddr, {
      positions_by_account: { account_id: accountId },
    });

    const rawPositions: any[] = resp.positions ?? [];
    const positions: OpenPosition[] = [];

    for (const pos of rawPositions) {
      const decimals = this.marketDecimalsCache[pos.denom] ??  6;
      const sizeFloat = parseFloat(pos.size) / 10 ** decimals;

      positions.push({
        market: pos.denom,
        size: Math.abs(sizeFloat),
        side: sizeFloat >= 0 ? "long" : "short",
        margin: pos.margin ?? "0",
        entry_price: pos.entry_price ?? undefined,
        leverage: pos.leverage ?? undefined,
        unrealized_pnl: pos.unrealized_pnl ?? undefined,
        liquidation_price: pos.liquidation_price ?? undefined,
        position_id: pos.position_id ?? undefined,
        open_timestamp: pos.open_timestamp ? Number(pos.open_timestamp) : undefined,
        fee_paid: pos.fee_paid ?? undefined,
        unrealized_funding: pos.unrealized_funding ?? undefined,
        cumulative_funding: pos.cumulative_funding ?? undefined,
      });
    }
    return { positions } as PositionsByAccountResponse;
  }
  async getActiveTriggerOrders(accountId: string) {
    const res = await this.queryClient.queryContractSmart(this.creditManagerAddr, { all_account_trigger_orders: { account_id: accountId } }) as TriggerOrdersByAccountResp;
    return (res.data.data ?? []).map(x => x.order);
  }

  async getKeeperMinFee(): Promise<Coin> {
    const res = await this.queryClient.queryContractSmart(this.creditManagerAddr, { config: {} }) as CreditManagerConfigResp;
    return res.keeper_fee_config.min_fee;
  }

  /** Market Order setzen (long oder short) */
  async placeMarketOrder(params: {
    accountId: string;
    denom: string;
    size: number; // in Standard-Einheiten, z.B. BTC 0.1
    direction: "long" | "short";
    reduceOnly?: boolean;
  }) {
    // 1️⃣ Holen der Base-Decimals für den Markt
    const decimals = await this.getMarketDecimals(params.denom);

    // 2️⃣ Größe in Int128 umwandeln
    const sizeInt128 = (params.size * 10 ** decimals).toString();

    // 3️⃣ Long/Short: long = positive, short = negative
    const orderSizeInt128 = params.direction === "long" ? sizeInt128 : `-${sizeInt128}`;

    const usdcDenom = "ibc/B559A80D62249C8AA07A380E2A2BEA6E5CA9A6F079C912C3A9E9B494105E4F81";
    const order: any = {
      denom: params.denom,
      order_size: orderSizeInt128,
    };
    if (params.reduceOnly !== undefined) {
      order.reduce_only = params.reduceOnly;
    }
    const msg = {
      update_credit_account: {
        account_id: params.accountId,
        actions: [
          {
            execute_perp_order: order,
          },
	  {
           lend: { denom: usdcDenom, amount: "account_balance" },
          },      
        ] as Action[],
      },
    };

    const execMsg: EncodeObject = {
      typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
      value: MsgExecuteContract.fromPartial({
        sender: this.sender,
        contract: this.creditManagerAddr,
        msg: new TextEncoder().encode(JSON.stringify(msg)),
        funds: [],
      }),
    };
    let fee;
    try {
      const gas = await this.signingClient.simulate(this.sender, [execMsg], "");
      fee = calculateFee(
        Math.floor(gas * 1.3),
        GasPrice.fromString("0.025untrn")
      );
      this.lastGasUsed = gas;
    } catch (err) {

      console.warn("[Mars] Simulation failed, use fallback fee:", err.message);

      // Fallback Fee
      const fallbackGas = this.lastGasUsed
        ? Math.floor(this.lastGasUsed * 1.3)
        : 10_000_000; // Default 10M

      fee = {
        amount: [{ denom: "untrn", amount: "25000" }],
        gas: fallbackGas.toString(),
      };
    }

    return await this.signingClient.signAndBroadcast(
      this.sender,
      [execMsg],
      fee
    );
  }


  /** Limit Order setzen als Trigger Order (weil direkt Limit nicht möglich) */
  async placeLimitOrder(params: {
    accountId: string;
    denom: string;
    size: number;
    direction: "long" | "short";
    price: number;
    reduceOnly?: boolean;
  }) {
    const keeperFee = await this.getKeeperMinFee();
    const decimals = await this.getMarketDecimals(params.denom);

    const sizeInt128 = Math.floor(params.size * 10 ** decimals).toString();

    // Schritt 1: reclaim
    const reclaimAction: Action = {
      reclaim: { denom: keeperFee.denom, amount: { exact: keeperFee.amount } },
    };

    // Schritt 2: Trigger Order
    const actions: Action[] = [
      { execute_perp_order: { denom: params.denom, order_size: sizeInt128, reduce_only: params.reduceOnly ?? null } },
      { lend: { denom: keeperFee.denom, amount: "account_balance" } },
    ];

    const conditions: Condition[] = [
      {
        oracle_price: {
          comparison: params.direction === "long" ? "less_than" : "greater_than",
          denom: params.denom,
          price: params.price.toString(),
        },
      },
    ];

    const triggerAction: Action = { create_trigger_order: { actions, conditions, keeper_fee: keeperFee } };

    // Alles zusammen im update_credit_account
    const executeMsg = {
      update_credit_account: {
        account_id: params.accountId,
        actions: [reclaimAction, triggerAction],
      },
    };

    const result = await this.signingClient.execute(this.sender, this.creditManagerAddr, executeMsg, "auto");
    return result;
  }

  async deleteTriggerOrder(accountId: string, triggerOrderId: string) {
    const executeMsg = {
      update_credit_account: {
        account_id: accountId,
        actions: [
          {
            delete_trigger_order: {
              trigger_order_id: triggerOrderId,
            },
          },
        ],
      },
    };

    const result = await this.signingClient.execute(
      this.sender,
      this.creditManagerAddr,
      executeMsg,
      "auto"
    );

    return result;
  }
}


export default marsPerpsClient;
