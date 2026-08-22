/**
 * The trust anchors for atpm provenance verification.
 *
 * Everything Drydock is willing to believe about who built a release reduces
 * to the constants in this file: Sigstore's Fulcio roots, the Rekor log keys
 * and the window each was valid for, and the Fulcio extension OIDs that name
 * the builder. They are pinned rather than fetched — a publisher-controlled
 * bundle must not be able to nominate its own authority.
 *
 * Kept apart from the verification flow deliberately. Reviewing "what do we
 * trust" should not require reading how the checks are sequenced, and a change
 * here is a change to the trust model even when it looks like a data edit.
 */

/** Fulcio's public-good root (https://fulcio.sigstore.dev/api/v1/rootCert). */
export const FULCIO_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIB9zCCAXygAwIBAgIUALZNAPFdxHPwjeDloDwyYChAO/4wCgYIKoZIzj0EAwMw
KjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTAeFw0y
MTEwMDcxMzU2NTlaFw0zMTEwMDUxMzU2NThaMCoxFTATBgNVBAoTDHNpZ3N0b3Jl
LmRldjERMA8GA1UEAxMIc2lnc3RvcmUwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAT7
XeFT4rb3PQGwS4IajtLk3/OlnpgangaBclYpsYBr5i+4ynB07ceb3LP0OIOZdxex
X69c5iVuyJRQ+Hz05yi+UF3uBWAlHpiS5sh0+H2GHE7SXrk1EC5m1Tr19L9gg92j
YzBhMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBRY
wB5fkUWlZql6zJChkyLQKsXF+jAfBgNVHSMEGDAWgBRYwB5fkUWlZql6zJChkyLQ
KsXF+jAKBggqhkjOPQQDAwNpADBmAjEAj1nHeXZp+13NWBNa+EDsDP8G1WWg1tCM
WP/WHPqpaVo0jhsweNFZgSs0eE7wYI4qAjEA2WB9ot98sIkoF3vZYdd3/VtWB5b9
TNMea7Ix/stJ5TfcLLeABLE4BNJOsQ4vnBHJ
-----END CERTIFICATE-----`;

/**
 * Fulcio intermediates that may issue a signing certificate. A list rather than
 * a constant so a Sigstore rotation is one appended PEM: certificates issued
 * under a retired intermediate must keep verifying.
 */
export const FULCIO_INTERMEDIATE_PEMS = [
  `-----BEGIN CERTIFICATE-----
MIICGjCCAaGgAwIBAgIUALnViVfnU0brJasmRkHrn/UnfaQwCgYIKoZIzj0EAwMw
KjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTAeFw0y
MjA0MTMyMDA2MTVaFw0zMTEwMDUxMzU2NThaMDcxFTATBgNVBAoTDHNpZ3N0b3Jl
LmRldjEeMBwGA1UEAxMVc2lnc3RvcmUtaW50ZXJtZWRpYXRlMHYwEAYHKoZIzj0C
AQYFK4EEACIDYgAE8RVS/ysH+NOvuDZyPIZtilgUF9NlarYpAd9HP1vBBH1U5CV7
7LSS7s0ZiH4nE7Hv7ptS6LvvR/STk798LVgMzLlJ4HeIfF3tHSaexLcYpSASr1kS
0N/RgBJz/9jWCiXno3sweTAOBgNVHQ8BAf8EBAMCAQYwEwYDVR0lBAwwCgYIKwYB
BQUHAwMwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQU39Ppz1YkEZb5qNjp
KFWixi4YZD8wHwYDVR0jBBgwFoAUWMAeX5FFpWapesyQoZMi0CrFxfowCgYIKoZI
zj0EAwMDZwAwZAIwPCsQK4DYiZYDPIaDi5HFKnfxXx6ASSVmERfsynYBiX2X6SJR
nZU84/9DZdnFvvxmAjBOt6QpBlc4J/0DxvkTCqpclvziL6BCCPnjdlIB3Pu3BxsP
mygUY7Ii2zbdCdliiow=
-----END CERTIFICATE-----`,
];

/**
 * Sigstore's public-good Rekor keys, copied from its signed trusted root.
 * Like the Fulcio anchors above, rotations are explicit code changes so a
 * publisher-controlled bundle cannot nominate its own timestamp authority.
 */
export const REKOR_LOG_KEYS = [
  {
    keyId: "wNI9atQGlz+VWfO6LRygH4QUfY/8W4RFwiT5i5WRgB0=",
    baseUrl: "https://rekor.sigstore.dev",
    spki: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwrkBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==",
    validFrom: Date.parse("2021-01-12T11:53:27Z"),
    algorithm: { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const,
  },
  {
    keyId: "zxGZFVvd0FEmjR8WrFwMdcAJ9vtaY/QXf44Y1wUeP6A=",
    baseUrl: "https://log2025-1.rekor.sigstore.dev",
    spki: "MCowBQYDK2VwAyEAt8rlp1knGwjfbcXAYPYAkn0XiLz1x8O4t0YkEhie244=",
    validFrom: Date.parse("2025-09-23T00:00:00Z"),
    algorithm: { name: "Ed25519" } as const,
  },
] as const;

// Fulcio extension OIDs (https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md)
export const OID_ISSUER = "1.3.6.1.4.1.57264.1.8";
export const OID_RUNNER_ENVIRONMENT = "1.3.6.1.4.1.57264.1.11";
export const OID_SOURCE_REPO_URI = "1.3.6.1.4.1.57264.1.12";
export const OID_SOURCE_REPO_DIGEST = "1.3.6.1.4.1.57264.1.13";
export const OID_SOURCE_REPO_REF = "1.3.6.1.4.1.57264.1.14";
export const OID_BUILD_CONFIG_URI = "1.3.6.1.4.1.57264.1.18";
export const OID_RUN_INVOCATION_URI = "1.3.6.1.4.1.57264.1.21";
export const OID_SOURCE_REPO_VISIBILITY = "1.3.6.1.4.1.57264.1.22";

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
