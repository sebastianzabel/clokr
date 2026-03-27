<script lang="ts">
  interface Props {
    password: string;
    policy: {
      passwordMinLength: number;
      passwordRequireUpper: boolean;
      passwordRequireLower: boolean;
      passwordRequireDigit: boolean;
      passwordRequireSpecial: boolean;
    };
  }

  let { password, policy }: Props = $props();

  let checks = $derived([
    { label: `Min. ${policy.passwordMinLength} Zeichen`, ok: password.length >= policy.passwordMinLength },
    ...(policy.passwordRequireUpper ? [{ label: "Großbuchstabe (A-Z)", ok: /[A-Z]/.test(password) }] : []),
    ...(policy.passwordRequireLower ? [{ label: "Kleinbuchstabe (a-z)", ok: /[a-z]/.test(password) }] : []),
    ...(policy.passwordRequireDigit ? [{ label: "Ziffer (0-9)", ok: /\d/.test(password) }] : []),
    ...(policy.passwordRequireSpecial ? [{ label: "Sonderzeichen (!@#...)", ok: /[^A-Za-z0-9]/.test(password) }] : []),
  ]);

  let passedCount = $derived(checks.filter((c) => c.ok).length);
  let allPassed = $derived(passedCount === checks.length);
  let strength = $derived(
    checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100),
  );
</script>

{#if password.length > 0}
  <div class="pw-strength">
    <div class="pw-bar-track">
      <div
        class="pw-bar-fill"
        class:pw-weak={strength < 50}
        class:pw-medium={strength >= 50 && strength < 100}
        class:pw-strong={strength === 100}
        style="width:{strength}%"
      ></div>
    </div>
    <ul class="pw-checks">
      {#each checks as c}
        <li class="pw-check" class:pw-check-ok={c.ok}>
          <span class="pw-check-icon">{c.ok ? "✓" : "○"}</span>
          {c.label}
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .pw-strength {
    margin-top: 0.5rem;
  }
  .pw-bar-track {
    height: 4px;
    background: var(--gray-200);
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 0.5rem;
  }
  .pw-bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s ease, background 0.3s ease;
  }
  .pw-weak { background: var(--color-red); }
  .pw-medium { background: var(--color-yellow); }
  .pw-strong { background: var(--color-green); }
  .pw-checks {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
  }
  .pw-check {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .pw-check-ok {
    color: var(--color-green);
  }
  .pw-check-icon {
    font-size: 0.7rem;
  }
</style>
