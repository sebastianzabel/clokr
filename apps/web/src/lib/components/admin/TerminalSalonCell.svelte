<!-- Issue #541: RED stub of the terminal salon cell; replaced by the real component in the GREEN commit. -->
<script lang="ts">
  interface Props {
    terminal: {
      id: string;
      name: string;
      salonId: string | null;
      salonName: string | null;
      salonActive: boolean | null;
      revokedAt: string | null;
    };
    salons: { id: string; name: string }[];
    showOptions: boolean;
    onchange: (salonId: string | null) => Promise<boolean>;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const props: Props = $props();
</script>
