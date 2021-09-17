import { CfnDomain, CfnRepository } from '@aws-cdk/aws-codeartifact';
import { InterfaceVpcEndpoint } from '@aws-cdk/aws-ec2';
import { Effect, Grant, IGrantable, PolicyStatement } from '@aws-cdk/aws-iam';
import { ArnFormat, Construct, IConstruct, Lazy, Stack } from '@aws-cdk/core';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from '@aws-cdk/custom-resources';
import * as api from './api';

export interface RepositoryProps {
  /**
   * The description of the Repository resource.
   */
  readonly description?: string;

  /**
   * The name of the Domain.
   *
   * @default - a name is generated by CDK.
   */
  readonly domainName?: string;

  /**
   * Specify `domainName` and `domainExists: true` in order to use an existing
   * CodeArtifact domain instead of creating a new one.
   *
   * @default false
   */
  readonly domainExists?: boolean;

  /**
   * The name of the Repository.
   *
   * @default - a name is generated by CDK.
   */
  readonly repositoryName?: string;

  /**
   * The name of upstream repositories to configure on this repository. Those
   * repositories must be in the same domain, hence this property can only be
   * used if `domainExists` is `true`.
   *
   * @default - none
   */
  readonly upstreams?: string[];
}

export interface IRepository extends IConstruct, api.IRepository {
  /** The ARN of the CodeArtifact Domain that contains the repository. */
  readonly repositoryDomainArn: string;

  /** The effective name of the CodeArtifact Domain. */
  readonly repositoryDomainName: string;

  /** The owner account of the CodeArtifact Domain. */
  readonly repositoryDomainOwner: string;

  /** The ARN of the CodeArtifact Repository. */
  readonly repositoryArn: string;

  /** The effective name of the CodeArtifact Repository. */
  readonly repositoryName: string;

  /** The URL to the endpoint of the CodeArtifact Repository for use with NPM. */
  readonly repositoryNpmEndpoint: string;

  /**
   * Grants read-only access to the repository, for use with NPM.
   *
   * @param grantee the entity to be granted read access.
   *
   * @returns the resulting `Grant`.
   */
  grantReadFromRepository(grantee: IGrantable): Grant;
}

/**
 * A CodeArtifact repository.
 */
export class Repository extends Construct implements IRepository {
  /**
   * The ARN of the CodeArtifact Domain that contains the repository.
   */
  public readonly repositoryDomainArn: string;

  /**
   * The name of the CodeArtifact Domain that contains the repository.
   */
  public readonly repositoryDomainName: string;

  /**
   * The account ID that owns the CodeArtifact Domain that contains the repository.
   */
  public readonly repositoryDomainOwner: string;

  /**
   * The ARN of the CodeArtifact Repository.
   */
  public readonly repositoryArn: string;

  /**
   * The name of the CodeArtifact Repository.
   */
  public readonly repositoryName: string;

  readonly #externalConnections = new Array<string>();

  #repositoryNpmEndpoint?: string;
  #s3BucketArn?: string;

  public constructor(scope: Construct, id: string, props?: RepositoryProps) {
    super(scope, id);

    if (props?.domainExists && !props.domainName) {
      throw new Error('domainExists cannot be specified if no domainName is provided');
    }
    if (props?.upstreams && !props.domainExists) {
      throw new Error('upstreams can only be specified if domainExists and domainName are provided');
    }

    const domainName = props?.domainName ?? this.node.addr;
    const domain = props?.domainExists ? undefined : new CfnDomain(this, 'Domain', { domainName });

    const repository = new CfnRepository(this, 'Default', {
      description: props?.description,
      domainName: domain?.attrName ?? domainName,
      externalConnections: Lazy.list({ produce: () => this.#externalConnections.length > 0 ? this.#externalConnections : undefined }),
      repositoryName: props?.repositoryName ?? this.node.addr,
      upstreams: props?.upstreams,
    });

    this.repositoryDomainArn = domain?.attrArn ?? Stack.of(this).formatArn({
      service: 'codeartifact',
      resource: 'domain',
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      resourceName: domainName,
    });
    this.repositoryDomainName = repository.attrDomainName;
    this.repositoryDomainOwner = repository.attrDomainOwner;
    this.repositoryArn = repository.attrArn;
    this.repositoryName = repository.attrName;
  }

  /**
   * Adds an external connection to this repository.
   *
   * @param id the id of the external connection (i.e: `public:npmjs`).
   */
  public addExternalConnection(id: string): void {
    if (!this.#externalConnections.includes(id)) {
      this.#externalConnections.push(id);
    }
  }

  /**
   * The npm repository endpoint to use for interacting with this repository.
   */
  public get repositoryNpmEndpoint(): string {
    if (this.#repositoryNpmEndpoint == null) {
      const serviceCall = {
        service: 'CodeArtifact',
        action: 'getRepositoryEndpoint',
        parameters: {
          domain: this.repositoryDomainName,
          domainOwner: this.repositoryDomainOwner,
          format: 'npm',
          repository: this.repositoryName,
        },
        physicalResourceId: PhysicalResourceId.fromResponse('repositoryEndpoint'),
      };
      const endpoint = new AwsCustomResource(this, 'GetEndpoint', {
        onCreate: serviceCall,
        onUpdate: serviceCall,
        policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: [this.repositoryArn] }),
        resourceType: 'Custom::CodeArtifactNpmRepositoryEndpoint',
      });
      this.#repositoryNpmEndpoint = endpoint.getResponseField('repositoryEndpoint');
    }
    return this.#repositoryNpmEndpoint;
  }

  /**
   * The S3 bucket in which CodeArtifact stores the package data. When using
   * VPC Endpoints for CodeArtifact, an S3 Gateway Endpoint must also be
   * available, which allows reading from this bucket.
   */
  public get s3BucketArn(): string {
    if (this.#s3BucketArn == null) {
      const domainDescription = new AwsCustomResource(this, 'DescribeDomain', {
        onCreate: {
          service: 'CodeArtifact',
          action: 'describeDomain',
          parameters: {
            domain: this.repositoryDomainName,
            domainOwner: this.repositoryDomainOwner,
          },
          physicalResourceId: PhysicalResourceId.fromResponse('domain.s3BucketArn'),
        },
        policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: [this.repositoryDomainArn] }),
        resourceType: 'Custom::CoreArtifactDomainDescription',
      });
      this.#s3BucketArn = domainDescription.getResponseField('domain.s3BucketArn');
    }
    return this.#s3BucketArn;
  }

  public grantReadFromRepository(grantee: IGrantable): Grant {
    // The Grant API does not allow conditions
    const stsGrantResult = grantee.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['sts:GetServiceBearerToken'],
      conditions: { StringEquals: { 'sts:AWSServiceName': 'codeartifact.amazonaws.com' } },
      resources: ['*'], // STS does not support resource-specified permissions
    }));
    if (!stsGrantResult.statementAdded) {
      return Grant.drop(grantee, 'CodeArtifact:ReadFromRepository');
    }
    return Grant.addToPrincipal({
      grantee,
      actions: [
        'codeartifact:GetAuthorizationToken',
        'codeartifact:GetRepositoryEndpoint',
        'codeartifact:ReadFromRepository',
      ],
      resourceArns: [this.repositoryDomainArn, this.repositoryArn],
    });
  }

  /**
   * Obtains a view of this repository that is intended to be accessed though
   * VPC endpoints.
   *
   * @param apiEndpoint  an `InterfaceVpcEndpoint` to the `codeartifact.api`
   *                     service.
   * @param repoEndpoint an `InterfaceVpcEndpoint` to the
   *                     `codeartifact.repositories` service.
   *
   * @returns a view of this repository that appropriately grants permissions on
   *          the VPC endpoint policies, too.
   */
  public throughVpcEndpoint(apiEndpoint: InterfaceVpcEndpoint, repoEndpoint: InterfaceVpcEndpoint): IRepository {
    return new Proxy(this, {
      get(target, property, _receiver) {
        if (property === 'grantReadFromRepository') {
          return decoratedGrantReadFromRepository.bind(target);
        }
        return (target as any)[property];
      },
      getOwnPropertyDescriptor(target, property) {
        const realDescriptor = Object.getOwnPropertyDescriptor(target, property);
        if (property === 'grantReadFromRepository') {
          return {
            ...realDescriptor,
            value: decoratedGrantReadFromRepository,
            get: undefined,
            set: undefined,
          };
        }
        return realDescriptor;
      },
    });

    function decoratedGrantReadFromRepository(this: Repository, grantee: IGrantable): Grant {
      const mainGrant = this.grantReadFromRepository(grantee);
      if (mainGrant.success) {
        apiEndpoint.addToPolicy(new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['sts:GetServiceBearerToken'],
          conditions: { StringEquals: { 'sts:AWSServiceName': 'codeartifact.amazonaws.com' } },
          resources: ['*'], // STS does not support resource-specified permissions
          principals: [grantee.grantPrincipal],
        }));
        apiEndpoint.addToPolicy(new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['codeartifact:GetAuthorizationToken', 'codeartifact:GetRepositoryEndpoint'],
          resources: [this.repositoryDomainArn, this.repositoryArn],
          principals: [grantee.grantPrincipal],
        }));
        repoEndpoint.addToPolicy(new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['codeartifact:ReadFromRepository'],
          resources: [this.repositoryArn],
          principals: [grantee.grantPrincipal],
        }));
      }
      return mainGrant;
    }
  }
}
