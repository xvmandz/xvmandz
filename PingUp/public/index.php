<?php
require dirname(__DIR__) . '/src/security-headers.php';
$v = '2.1.0';
?>
<!DOCTYPE html>
<html lang="uk" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
  <meta name="theme-color" content="#0a0c12">
  <meta name="description" content="PingUp — Just ping. Your quiet place to stay close.">
  <meta name="color-scheme" content="dark light">
  <title>PingUp — Just ping.</title>
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="apple-touch-icon" href="assets/icons/icon-192.png">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <link rel="icon" type="image/svg+xml" href="assets/logo.svg">
  <link rel="stylesheet" href="app.css?v=<?= $v ?>">
  <link rel="stylesheet" href="calls.css?v=<?= $v ?>">
  <script src="ui.js?v=<?= $v ?>" defer></script>
  <script src="experience.js?v=<?= $v ?>" defer></script>
  <script src="calls.js?v=<?= $v ?>" defer></script>
  <script src="app.js?v=<?= $v ?>" defer></script>
  <script src="chat.js?v=<?= $v ?>" defer></script>
  <script src="pages.js?v=<?= $v ?>" defer></script>
  <script src="settings.js?v=<?= $v ?>" defer></script>
</head>
<body>
  <div id="app"><div class="boot-screen"><img src="assets/logo.svg" alt="PingUp" width="64" height="74"><div class="loading-line"></div><p>Just ping.</p></div></div>
  <div id="toasts" class="toast-container" aria-live="polite"></div>
</body>
</html>
