// ~~ Generated by projen. To modify, edit .projenrc.js and run "npx projen".
import * as path from 'path';
import * as lambda from '@aws-cdk/aws-lambda';
import { Construct } from 'constructs';

export interface HelloProps extends lambda.FunctionOptions {
}

export class Hello extends lambda.Function {
  constructor(scope: Construct, id: string, props: HelloProps = {}) {
    super(scope, id, {
      runtime: lambda.Runtime.NODEJS_14_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.resolve(__dirname, '/hello.bundle')),
      ...props,
    });
  }
}