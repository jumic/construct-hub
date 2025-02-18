import { IFunction, Tracing } from '@aws-cdk/aws-lambda';
import { RetentionDays } from '@aws-cdk/aws-logs';
import { IBucket } from '@aws-cdk/aws-s3';
import { Construct, Duration } from '@aws-cdk/core';

import { Monitoring } from '../../monitoring';
import { DenyList } from '../deny-list';
import { CatalogBuilder as Handler } from './catalog-builder';

export interface CatalogBuilderProps {
  /**
   * The package store bucket.
   */
  readonly bucket: IBucket;

  /**
   * The monitoring handler to register alarms with.
   */
  readonly monitoring: Monitoring;

  /**
   * How long should execution logs be retained?
   *
   * @default RetentionDays.TEN_YEARS
   */
  readonly logRetention?: RetentionDays;

  /**
   * The deny list construct.
   */
  readonly denyList: DenyList;
}

/**
 * Builds or re-builds the `catalog.json` object in the designated bucket.
 */
export class CatalogBuilder extends Construct {
  public readonly function: IFunction;

  public constructor(scope: Construct, id: string, props: CatalogBuilderProps) {
    super(scope, id);

    const handler = new Handler(this, 'Default', {
      description: `Creates the catalog.json object in ${props.bucket.bucketName}`,
      environment: {
        BUCKET_NAME: props.bucket.bucketName,
        AWS_EMF_ENVIRONMENT: 'Local',
      },
      logRetention: props.logRetention ?? RetentionDays.TEN_YEARS,
      memorySize: 10_240, // Currently the maximum possible setting
      reservedConcurrentExecutions: 1,
      timeout: Duration.minutes(15),
      tracing: Tracing.PASS_THROUGH,
    });
    this.function = handler;

    // allow the catalog builder to use the client.
    props.denyList.grantRead(handler);

    props.bucket.grantReadWrite(this.function);
  }
}
