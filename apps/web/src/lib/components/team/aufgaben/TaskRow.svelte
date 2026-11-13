<script lang="ts">
  // Issue #853 (D-853-06, D-853-18) - one row of the Aufgaben list: a `ListRow` of the task variant.
  // Template only: the page decides which row exists, what the title button opens and which buttons
  // sit under the text. Issue #853-19 (prototype „Aufgaben“): every row has ONE context line under the
  // title (`row.context`, or the `context` prop the page read for a leave row within the caller's
  // permissions), and a leave row names its type as a plain `Chip` (a plain pill); the status
  // stays a `Chip` next to it.
  import type { Snippet } from "svelte";
  import ListRow from "$components/ui/ListRow.svelte";
  import Chip, { type ChipTone } from "$components/ui/Chip.svelte";
  import { taskKindLabel, type TaskRowModel } from "$lib/team/task-model";

  interface Props {
    row: TaskRowModel;
    /** The label of the leave type (only read for a leave row). */
    typeLabel?: string;
    /** The context line the page read for this row (a leave row); wins over the model's own. */
    context?: string | null;
    /** The `id` of the `li` (a deep link target). */
    rowId?: string;
    /** Tints the row (a deep-linked entry). */
    highlight?: boolean;
    /** The title becomes the row's one button. */
    onOpen?: () => void;
    /** The buttons under the text. */
    actions?: Snippet;
  }

  let { row, typeLabel, context, rowId, highlight = false, onOpen, actions }: Props = $props();

  const STATUS: Record<string, { label: string; tone: ChipTone }> = {
    PENDING: { label: "Ausstehend", tone: "warn" },
    CANCELLATION_REQUESTED: { label: "Stornierung beantragt", tone: "warn" },
    APPROVED: { label: "Genehmigt", tone: "ok" },
    REJECTED: { label: "Abgelehnt", tone: "bad" },
    USED: { label: "Verwendet", tone: "neutral" },
    // § 9 cases (the model's own status values: the case waits for the AU, or was rejected).
    AU_PENDING: { label: "AU ausstehend", tone: "warn" },
    AU_REJECTED: { label: "AU abgelehnt", tone: "bad" },
  };

  const status = $derived(STATUS[row.status]);
  const contextLine = $derived(context ?? row.context ?? undefined);
</script>

<ListRow
  variant="task"
  title={row.title}
  subtitle={row.subtitle}
  context={contextLine}
  avatarKey={row.personName}
  testId={`task-row-${row.kind}-${row.sourceId}`}
  kind={row.kind}
  {rowId}
  {highlight}
  onPrimary={onOpen}
  {actions}
>
  {#snippet meta()}
    {#if row.kind === "urlaub" && row.typeCode}
      <Chip tone="neutral">{typeLabel ?? row.typeCode}</Chip>
    {:else}
      <Chip tone="info">{row.label ?? taskKindLabel(row.kind)}</Chip>
    {/if}
    {#if status}
      <Chip tone={status.tone}>{status.label}</Chip>
    {/if}
  {/snippet}
</ListRow>
