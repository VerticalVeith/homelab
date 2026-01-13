/* Renovate configuration for this repository
 * - Groups GitHub Actions updates
 * - Updates container images referenced in manifests and base YAMLs
 * - Attempts to update Helm chart versions used by ArgoCD apps
 * Adjust patterns as needed for your repo layout.
 */

module.exports = {
  extends: ["config:base"],
  onboarding: false,
  labels: ["dependencies"],
  schedule: ["before 3am on monday"],

  packageRules: [
    {
      description: "Group all GitHub Actions updates into a single PR",
      matchManagers: ["github-actions"],
      groupName: "all GitHub Actions",
    },
    {
      description: "Group Helm chart version updates used by ArgoCD apps",
      matchDatasources: ["helm"],
      matchPaths: ["^manifests/.*/helm-.*\\.ya?ml$", "^base/.*\\.ya?ml$"],
      groupName: "argocd helm charts",
    },
    {
      description: "Group minor and patch updates",
      matchUpdateTypes: ["minor", "patch"],
      groupName: "minor and patch updates",
    }
  ],

  // Regex managers to detect images and chart versions in YAML manifests
  regexManagers: [
    {
      fileMatch: ["^manifests/.*\\.ya?ml$", "^base/.*\\.ya?ml$"],
      matchStrings: [
        // Matches lines like: image: ghcr.io/org/image:1.2.3
        "(?m)^\\s*image:\\s*(?<depName>[^:\\s]+):(?<currentValue>\\d+\\.\\d+\\.\\d+(?:[-+][^\\s]+)?)"
      ],
      datasourceTemplate: "docker",
      depNameTemplate: "{{{depName}}}",
      versioningTemplate: "docker"
    },
    {
      // Attempt to catch Helm charts declared in "helm-*.yaml" files with a nearby `version:` field.
      fileMatch: ["^manifests/.*/helm-.*\\.ya?ml$", "^base/.*\\.ya?ml$"],
      matchStrings: [
        // Tries to match a `chart:` line and a following `version: x.y.z` on a nearby line
        "(?ms)^\\s*chart:\\s*(?<depName>[^\\s@]+/[^\\s@]+).*?^\\s*version:\\s*(?<currentValue>\\d+\\.\\d+\\.\\d+)"
      ],
      datasourceTemplate: "helm",
      depNameTemplate: "{{{depName}}}",
      versioningTemplate: "semver"
    }
  ]
};
