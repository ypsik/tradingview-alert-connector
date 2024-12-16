import chalk from 'chalk';

export class CustomLogger {
	private exchangeName: string;

	constructor(exchangeName: string) {
		this.exchangeName = exchangeName;
	}

	log(message: unknown, ...optionalParams: unknown[]) {
		if (typeof message === 'object') return this.logJson(message);
		const timestamp = this.getTimestamp();
		const formattedMessage = `[${chalk.blue(this.exchangeName)}] ${chalk.green(
			message
		)}`;

		console.log(
			`${chalk.gray(timestamp)} ${formattedMessage}`,
			...optionalParams
		);
	}

	warn(message: unknown, ...optionalParams: unknown[]) {
		const timestamp = this.getTimestamp();
		const formattedMessage = `[${chalk.yellow(
			this.exchangeName
		)}] ${chalk.yellowBright(message)}`;

		console.warn(
			`${chalk.gray(timestamp)} ${formattedMessage}`,
			...optionalParams
		);
	}

	error(message: unknown | Error, ...optionalParams: unknown[]) {
		if ((message as Error)?.stack) {
			return this.errorWithTrace(message as Error);
		}

		const timestamp = this.getTimestamp();
		const formattedMessage = `[${chalk.red(
			this.exchangeName
		)}] ${chalk.redBright(message)}`;

		console.error(
			`${chalk.gray(timestamp)} ${formattedMessage}`,
			...optionalParams
		);
	}

	private errorWithTrace({ message, stack }: Error) {
		const timestamp = this.getTimestamp();
		const formattedMessage = `[${chalk.red(
			this.exchangeName
		)}] ${chalk.redBright(message)}`;
		const formattedStack = `${chalk.gray(stack)}`;

		console.error(`${chalk.gray(timestamp)} ${formattedMessage}`);
		console.error(formattedStack);
	}

	private logJson(message: unknown) {
		const timestamp = this.getTimestamp();
		console.log(
			`${chalk.gray(timestamp)} [${chalk.blue(this.exchangeName)}]` +
				chalk.cyan(JSON.stringify(message, null, 2))
		);
	}

	protected getTimestamp(): string {
		const [timestamp] = new Date().toISOString().split('Z');
		return timestamp.replace('T', ' ');
	}
}
