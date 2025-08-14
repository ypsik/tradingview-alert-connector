import { EventEmitter } from "events";
import {
  UserAccountSubscriber,
  DataAndSlot,
  UserAccount,
} from "@drift-labs/sdk";

export class  CustomUserAccountSubscriber implements UserAccountSubscriber {
  isSubscribed = false;
  connection: any;
  program: any;
  userAccountPublicKey: any;
  interval: NodeJS.Timeout | undefined;
  data: UserAccount | undefined;
  slot: number | undefined;
  pollingInterval: number; // in ms
  eventEmitter = new EventEmitter();

  constructor(connection, program, userAccountPublicKey, pollingInterval = 30_000) {
    this.connection = connection;
    this.program = program;
    this.userAccountPublicKey = userAccountPublicKey;
    this.pollingInterval = pollingInterval;
  }

  async subscribe(): Promise<boolean> {
    this.isSubscribed = true;
    await this.updateData();
    this.interval = setInterval(() => this.updateData(), this.pollingInterval);
    return true;
  }

  async unsubscribe(): Promise<void> {
    this.isSubscribed = false;
    if (this.interval) clearInterval(this.interval);
  }

  async updateData(): Promise<void> {
    const accountInfo = await this.connection.getAccountInfo(this.userAccountPublicKey);
    if (!accountInfo) return;
    const account = await this.program.account.user.fetch(this.userAccountPublicKey);
    this.data = account;
    this.slot = accountInfo.slot;
    this.eventEmitter.emit("update");
  }

  async fetch(): Promise<void> {
    // Einmalig Daten laden, ohne Events zu triggern
    const accountInfo = await this.connection.getAccountInfo(this.userAccountPublicKey);
    if (!accountInfo) return;
    const account = await this.program.account.user.fetch(this.userAccountPublicKey);
    this.data = account;
    this.slot = accountInfo.slot;
  }

  getUserAccountAndSlot(): DataAndSlot<UserAccount> {
    return {
      data: this.data!,
      slot: this.slot ?? 0,
    };
  }
}
