<script lang="ts">
  import '../../sveltekit/app.css';
  let { children } = $props();
</script>

<svelte:head>
  <link rel="preconnect" href="https://rsms.me" />
  <link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link
    rel="stylesheet"
    href="https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,300..600;1,8..60,300..600&display=swap"
  />
</svelte:head>

<main class="min-h-screen bg-bg text-fg">
  {@render children?.()}
</main>
