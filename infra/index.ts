import * as pulumi from '@pulumi/pulumi'
import * as kube from '@pulumi/kubernetes'
import * as awsx from '@pulumi/awsx'

export const outputs = main()

async function main() {
    // get cluster information to know which cluster to deploy
    const environment = pulumi.getStack()
    const service_name = 'grimoirelab'

    if (environment === 'build') {
        const imageName = await buildImage(service_name)
        return imageName        
    }

    return deploy(service_name, environment)
}

async function buildImage(name: string): Promise<pulumi.Output<string>> {
    const ecr = await new awsx.ecr.Repository(
        name,
        {
            lifeCyclePolicyArgs: {
                rules: [
                    {
                        maximumNumberOfImages: 180,
                        selection: 'any'
                    }
                ]
            }
        }
    )

    return ecr.buildAndPushImage('.')
}

async function deploy(name: string, env: string) {

    const provider = new kube.Provider('megacluster-prod', { context: 'megacluster-prod' })
    const namespace = 'axiom'
    const repo = `978526999579.dkr.ecr.eu-west-1.amazonaws.com/${name}`
    const ecrEndpoint = `${repo}:latest`

    let secretEnvs: kube.types.input.core.v1.EnvVar[] = []

    const secretEnv = (key: string): kube.types.input.core.v1.EnvVar => {
        return {
            name: key,
            valueFrom: {
                secretKeyRef: {
                    name: `shapeshift-${env}`,
                    key: key
                }
            }
        }
    }

    secretEnvs = [
        'GRIMOIRELAB_GITHUB_TOKEN'
    ].map(secretEnv)


    const deployment = new kube.apps.v1.Deployment(
        'grimoirelab',
        {
            metadata: {
                labels: {
                    "app": name
                },
                namespace: namespace
            },
            spec: {
                selector: {
                    matchLabels: {
                        "app": name
                    }
                },
                replicas: 1,
                strategy: {
                    rollingUpdate: {
                        maxSurge: '100%',
                        maxUnavailable: '50%'
                    }
                },
                template: {
                    metadata: {
                        labels: {
                            "app": name
                        },
                    },
                    spec: {
                        affinity: {
                            podAntiAffinity: {
                                preferredDuringSchedulingIgnoredDuringExecution: [
                                    {
                                        weight: 1,
                                        podAffinityTerm: {
                                            labelSelector: {
                                                matchExpressions: [
                                                    {
                                                        key: 'app',
                                                        operator: 'In',
                                                        values: [ name ]
                                                    }
                                                ]
                                            },
                                            topologyKey: 'failure-domain.beta.kubernetes.io/zone'
                                        }
                                    }
                                ]
                            }
                        },
                        containers: [
                            {
                                name: name,
                                image: ecrEndpoint,
                                livenessProbe: undefined,
                                readinessProbe: undefined,
                                imagePullPolicy: 'IfNotPresent',
                                command: [
                                    '/entrypoint.sh',
                                    '-c',
                                    '/infra.cfg',
                                    '/dashboard.cfg',
                                    '/project.cfg',
                                    '/override.cfg'
                                ],
                                ports: [
                                    { containerPort: 5601 }
                                ],
                                env: [
                                    ...secretEnvs
                                ],
                                resources: {
                                    limits: {
                                        cpu: '2048m',
                                        memory: '8G'
                                    },
                                    requests: {
                                        cpu: '2048m',
                                        memory: '8G'
                                    }
                                },
                            },
                        ],
                    },
                }
            }
        },
        { provider: provider }
    )

    const service = new kube.core.v1.Service(
        'grimoirelab',
        {
            metadata: {
                labels: deployment.metadata.labels,
                name: name,
                namespace: deployment.metadata.namespace
            },
            spec: {
                ports: [
                    { 
                        name: 'http',
                        port: deployment.spec.template.spec.containers[0].ports[0].containerPort,
                        protocol: 'TCP'
                    }
                ],
                selector: deployment.spec.selector.matchLabels,
                type: 'ClusterIP'
            }
        },
        { provider: provider }
    )

    const choeListenerRule: kube.types.input.networking.v1beta1.IngressRule = {
        host: pulumi.interpolate`${name}.chiefhappinessofficerellie.org`,
        http: {
            paths: [
                {
                    backend: {
                        serviceName: service.metadata.name,
                        servicePort: deployment.spec.template.spec.containers[0].ports[0].containerPort
                    }
                }
            ]
        }
    }

    const shapeshiftListenerRule: kube.types.input.networking.v1beta1.IngressRule = {
        host: 'analytics.shapeshift.com',
        http: {
            paths: [
                {
                    backend: {
                        serviceName: service.metadata.name,
                        servicePort: deployment.spec.template.spec.containers[0].ports[0].containerPort
                    }
                }
            ]
        }
    }

    const foxfoundationListenerRule: kube.types.input.networking.v1beta1.IngressRule = {
        host: 'analytics.foxfoundation.io',
        http: {
            paths: [
                {
                    backend: {
                        serviceName: service.metadata.name,
                        servicePort: deployment.spec.template.spec.containers[0].ports[0].containerPort
                    }
                }
            ]
        }
    }

    const rules = [foxfoundationListenerRule, shapeshiftListenerRule, choeListenerRule]

    const ingress = new kube.networking.v1beta1.Ingress(
        name,
        {
            metadata: {
                namespace: namespace
            },
            spec: {
                rules: rules
            }
        },
        { provider: provider }
    )

    return ingress.spec.rules[0].host
}