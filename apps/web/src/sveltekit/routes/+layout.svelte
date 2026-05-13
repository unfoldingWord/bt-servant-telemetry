<script lang="ts">
  import '../../sveltekit/app.css';
  let { children } = $props();
</script>

<svelte:head>
  <link rel="preconnect" href="https://rsms.me" />
  <link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
</svelte:head>

<main class="min-h-screen bg-bg text-fg">
  {@render children?.()}
</main>
