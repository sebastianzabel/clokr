{{/*
clokr-app name
*/}}
{{- define "clokr-app.name" -}}
{{- default "clokr-app" .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
clokr-app fullname
*/}}
{{- define "clokr-app.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- default .Release.Name (include "clokr-app.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
Common labels
*/}}
{{- define "clokr-app.labels" -}}
app.kubernetes.io/name: {{ include "clokr-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
