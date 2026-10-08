<?php
require dirname(__DIR__) . '/src/security-headers.php';
?>
<!DOCTYPE html>
<html lang="uk" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
  <meta name="theme-color" content="#090b12">
  <meta name="description" content="PingUp — Just ping. Your quiet place to stay close.">
  <title>PingUp — Just ping.</title>
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="apple-touch-icon" href="assets/icons/icon-192.png">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <link rel="icon" type="image/svg+xml" href="assets/logo.svg">
  <link rel="stylesheet" href="styles.css?v=2.0.0-beta.1">
  <link rel="stylesheet" href="calls.css?v=2.0.0-beta.1">
  <link rel="stylesheet" href="experience.css?v=2.0.0-beta.1">
  <link rel="stylesheet" href="motion.css?v=2.0.0-beta.1">
  <script src="experience.js?v=2.0.0-beta.1" defer></script>
  <script src="calls.js?v=2.0.0-beta.1" defer></script>
  <script src="app.js?v=2.0.0-beta.1" defer></script>
</head>
<body>
  <div class="ambient" aria-hidden="true"><i></i><i></i><i></i></div>
  <div id="app"><div class="boot-screen"><img src="assets/logo.svg" alt="PingUp" width="64" height="74"><div class="loading-line"></div><p>Just ping.</p></div></div>
  <dialog id="modal" class="modal"></dialog>
  <div id="toasts" class="toast-container" aria-live="polite"></div>
  <input type="file" id="attachment-input" hidden>
  <input type="file" id="avatar-input" accept="image/jpeg,image/png,image/webp" hidden>
</body>
</html>
