# Fliks

## Angular conventions

- Always use external template files (`templateUrl`) instead of inline templates (`template`) in components.
- Never hardcode user-facing strings. Use `TranslateService` (ngx-translate) for all text, including toast messages (e.g. `this.toast.success(this.translate.instant('key'))` not `this.toast.success('Settings saved')`).
