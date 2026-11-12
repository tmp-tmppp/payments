{{/* Name of every object of the release. */}}
{{- define "payments.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels that select the Pods; never change them after the first install (selectors are immutable). */}}
{{- define "payments.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Labels on every object. */}}
{{- define "payments.labels" -}}
{{ include "payments.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | trunc 63 | trimSuffix "-" | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Restricted security context of every container. */}}
{{- define "payments.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{/* Where the runtime ConfigMap is mounted (a directory mount). */}}
{{- define "payments.runtimeDir" -}}
/etc/payments/runtime
{{- end -}}
