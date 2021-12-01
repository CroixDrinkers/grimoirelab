import * as infra from '@foxcookieco/infrastructure'
import * as pulumi from '@pulumi/pulumi'
import * as kube from '@pulumi/kubernetes'

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
    const i = await infra.docker.buildAndPushImage(
        `${name}`,
        infra.git.getInfo().hash.short,
        {
            context: '.',
            dockerfile: 'Dockerfile',
            env: {
                DOCKER_BUILDKIT: '1'
            }
        }
    )
    return i.imageName
}

async function deploy(name: string, env: string) {
    const cluster = infra.kube.getClusterData('megacluster', env as 'stage' | 'prod')
    const namespace = 'shapeshift'
    const repo = `978526999579.dkr.ecr.eu-west-1.amazonaws.com/${name}`
    const tag = infra.git.getInfo().hash.short
    const ecrEndpoint = `${repo}:${tag}`

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
        { provider: cluster.provider }
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
        { provider: cluster.provider }
    )

    const choeListenerRule: kube.types.input.networking.v1beta1.IngressRule = {
        host: pulumi.interpolate`${name}.${cluster.domain}`,
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

    const publicListenerRule: kube.types.input.networking.v1beta1.IngressRule = {
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

    const rules = [publicListenerRule, choeListenerRule]

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
        { provider: cluster.provider }
    )

    return ingress.spec.rules[0].host
}