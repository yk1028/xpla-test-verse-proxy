import { Injectable } from '@nestjs/common';
import { IncomingHttpHeaders } from 'http';
import { ConfigService } from '@nestjs/config';
import { VerseService } from './verse.service';
import { TransactionService } from './transaction.service';
import {
  JsonrpcRequestBody,
  VerseRequestResponse,
  JsonrpcError,
} from 'src/entities';
import { TypeCheckService } from './typeCheck.service';
import { DatastoreService } from 'src/repositories';

@Injectable()
export class ProxyService {
  private allowedMethods: RegExp[];
  private isSetRateLimit: boolean;

  constructor(
    private configService: ConfigService,
    private readonly typeCheckService: TypeCheckService,
    private verseService: VerseService,
    private readonly txService: TransactionService,
    private readonly datastoreService: DatastoreService,
  ) {
    this.allowedMethods = this.configService.get<RegExp[]>(
      'allowedMethods',
    ) ?? [/^.*$/];
    this.isSetRateLimit = !!this.configService.get<string>('datastore');
  }

  async handleSingleRequest(
    headers: IncomingHttpHeaders,
    body: JsonrpcRequestBody,
    callback: (result: VerseRequestResponse) => void,
  ) {
    const result = await this.send(headers, body);
    callback(result);
  }

  async handleBatchRequest(
    headers: IncomingHttpHeaders,
    body: Array<JsonrpcRequestBody>,
    callback: (result: VerseRequestResponse) => void,
  ) {
    const results = await Promise.all(
      body.map(async (verseRequest): Promise<any> => {
        const result = await this.send(headers, verseRequest);
        return result.data;
      }),
    );
    callback({
      status: 200,
      data: results,
    });
  }

  async send(headers: IncomingHttpHeaders, body: JsonrpcRequestBody) {
    try {
      const method = body.method;
      this.checkMethod(method);

      if (method !== 'eth_sendRawTransaction') {
        const result = await this.verseService.post(headers, body);
        return result;
      }

      return await this.sendTransaction(headers, body);
    } catch (err) {
      const status = 200;
      if (err instanceof JsonrpcError) {
        const data = {
          jsonrpc: body.jsonrpc,
          id: body.id,
          error: {
            code: err.code,
            message: err.message,
          },
        };
        return {
          status,
          data,
        };
      }
      return {
        status,
        data: err,
      };
    }
  }

  async sendTransaction(
    headers: IncomingHttpHeaders,
    body: JsonrpcRequestBody,
  ) {
    const rawTx = body.params ? body.params[0] : undefined;
    if (!rawTx) throw new JsonrpcError('rawTransaction is not found', -32602);

    const tx = this.txService.parseRawTx(rawTx);

    if (!tx.from) throw new JsonrpcError('transaction is invalid', -32602);

    // contract deploy transaction
    if (!tx.to) {
      this.txService.checkContractDeploy(tx.from);
      await this.txService.checkAllowedGas(tx, body.jsonrpc, body.id);
      const result = await this.verseService.post(headers, body);
      return result;
    }

    // transaction other than contract deploy
    const methodId = tx.data.substring(0, 10);
    const matchedTxAllowRule = await this.txService.getMatchedTxAllowRule(
      tx.from,
      tx.to,
      methodId,
      tx.value,
    );
    await this.txService.checkAllowedGas(tx, body.jsonrpc, body.id);
    const result = await this.verseService.post(headers, body);

    if (!this.typeCheckService.isJsonrpcTxResponse(result.data))
      throw new JsonrpcError('Can not get verse response', -32603);
    const txHash = result.data.result;

    if (this.isSetRateLimit && matchedTxAllowRule.rateLimit)
      await this.datastoreService.setTransactionHistory(
        tx.from,
        tx.to,
        methodId,
        txHash,
        matchedTxAllowRule.rateLimit,
      );
    return result;
  }

  checkMethod(method: string) {
    const checkMethod = this.allowedMethods.some((allowedMethod) => {
      return allowedMethod.test(method);
    });
    if (!checkMethod)
      throw new JsonrpcError(`${method} is not allowed`, -32601);
  }
}
