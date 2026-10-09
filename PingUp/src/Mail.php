<?php
declare(strict_types=1);

// E-mail binding, verification codes, recovery and a PostgreSQL outbox delivered by bin/mail-worker.php.

const EMAIL_CODE_TTL = 900;
const EMAIL_CODE_ATTEMPTS = 5;

function appSecret(): string
{
    static $secret;
    if ($secret !== null) return $secret;
    $configured = (string)(config()['app_secret'] ?? '');
    if (strlen($configured) >= 32) return $secret = $configured;
    $path = config()['storage_path'] . '/app-secret.key';
    if (!is_file($path)) {
        $handle = @fopen($path, 'x');
        if ($handle) { fwrite($handle, bin2hex(random_bytes(32))); fclose($handle); @chmod($path, 0600); }
    }
    $value = trim((string)@file_get_contents($path));
    if (strlen($value) < 32) throw new RuntimeException('Application secret is not readable.');
    return $secret = $value;
}

function emailValue(mixed $value): string
{
    $email = strtolower(textValue($value, 254, 6));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL) || preg_match('/[\r\n<>"]/', $email)) throw new ApiError('invalid_email');
    return $email;
}

function maskEmail(string $email): string
{
    [$local, $domain] = explode('@', $email, 2) + [1 => ''];
    return mb_substr($local, 0, 1) . str_repeat('•', max(1, min(6, mb_strlen($local) - 1))) . '@' . $domain;
}

function emailCodeHash(int $tokenId, string $code): string
{
    return hash_hmac('sha256', $tokenId . ':' . $code, appSecret());
}

function smtpConfigured(): bool
{
    $config = config();
    return !empty($config['smtp_host']) && !empty($config['mail_from']);
}

function localeDictionary(string $locale): array
{
    static $cache = [];
    if (!in_array($locale, ['uk', 'ru', 'en'], true)) $locale = 'en';
    return $cache[$locale] ??= json_decode(file_get_contents(dirname(__DIR__) . '/public/locales/' . $locale . '.json'), true, 512, JSON_THROW_ON_ERROR);
}

/** Renders a localized message. Values are escaped for HTML; templates contain no user markup. */
function emailRender(string $locale, string $template, array $params): array
{
    $dict = localeDictionary($locale);
    $t = static function (string $key) use ($dict, $params): string {
        $value = $dict[$key] ?? $key;
        foreach ($params as $name => $param) $value = str_replace('{' . $name . '}', (string)$param, $value);
        return $value;
    };
    $subject = $t('email.' . $template . '.subject');
    $lines = array_values(array_filter([$t('email.' . $template . '.body'), isset($params['code']) ? $t('email.code_line') : null, $t('email.' . $template . '.footer')]));
    $text = $t('email.greeting') . "\n\n" . implode("\n\n", $lines) . "\n\n— PingUp";
    $html = '<!doctype html><html><body style="margin:0;background:#0f1220;font-family:Arial,sans-serif;color:#e8eaf6">'
        . '<div style="max-width:520px;margin:0 auto;padding:32px 24px"><div style="font-size:22px;font-weight:700;color:#a78bfa">PingUp</div>'
        . '<p style="font-size:16px">' . htmlspecialchars($t('email.greeting'), ENT_QUOTES) . '</p>';
    foreach ($lines as $line) $html .= '<p style="font-size:15px;line-height:1.5">' . nl2br(htmlspecialchars($line, ENT_QUOTES)) . '</p>';
    if (isset($params['code'])) $html .= '<div style="font-size:32px;letter-spacing:8px;font-weight:700;background:#1b2036;border-radius:12px;padding:16px;text-align:center">' . htmlspecialchars((string)$params['code'], ENT_QUOTES) . '</div>';
    $html .= '<p style="font-size:12px;color:#8b90ad">' . htmlspecialchars($t('email.automatic'), ENT_QUOTES) . '</p></div></body></html>';
    return ['subject' => $subject, 'text' => $text . "\n\n" . $t('email.automatic'), 'html' => $html];
}

function emailQueue(string $to, string $locale, string $template, array $params = []): void
{
    $mail = emailRender($locale, $template, $params);
    query('INSERT INTO email_outbox(to_email,subject,body_text,body_html,available_at,created_at) VALUES(?,?,?,?,?,?)', [$to, $mail['subject'], $mail['text'], $mail['html'], time(), time()]);
}

/** Security notices go to the verified address only. */
function emailNotice(array $user, string $template, array $params = []): void
{
    if (!empty($user['email']) && !empty($user['email_verified_at'])) emailQueue($user['email'], $user['locale'], $template, $params + ['name' => $user['name']]);
}

function emailIssueCode(int $userId, string $email, string $purpose): string
{
    $code = (string)random_int(100000, 999999);
    query('UPDATE email_tokens SET used_at=? WHERE user_id=? AND purpose=? AND used_at IS NULL', [time(), $userId, $purpose]);
    $id = insertId('INSERT INTO email_tokens(user_id,email,purpose,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)', [$userId, $email, $purpose, 'pending', time() + EMAIL_CODE_TTL, time()]);
    query('UPDATE email_tokens SET code_hash=? WHERE id=?', [emailCodeHash($id, $code), $id]);
    return $code;
}

/** Verifies the newest unused code. Counts attempts, single use, constant-time compare. */
function emailConsumeCode(int $userId, string $purpose, mixed $code): array
{
    if (!is_string($code) || !preg_match('/^\d{6}$/D', trim($code))) throw new ApiError('email_code_invalid');
    $result = transaction(function () use ($userId, $purpose, $code): array {
        $token = query('SELECT * FROM email_tokens WHERE user_id=? AND purpose=? AND used_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE', [$userId, $purpose])->fetch();
        if (!$token || (int)$token['expires_at'] < time()) return ['error' => 'email_code_expired'];
        if ((int)$token['attempts'] >= EMAIL_CODE_ATTEMPTS) return ['error' => 'email_code_attempts'];
        if (!hash_equals($token['code_hash'], emailCodeHash((int)$token['id'], trim($code)))) {
            // The failed attempt is committed before the error is reported.
            query('UPDATE email_tokens SET attempts=attempts+1 WHERE id=?', [$token['id']]);
            return ['error' => 'email_code_invalid'];
        }
        query('UPDATE email_tokens SET used_at=? WHERE id=?', [time(), $token['id']]);
        return ['token' => $token];
    });
    if (isset($result['error'])) throw new ApiError($result['error'], match ($result['error']) { 'email_code_expired' => 410, 'email_code_attempts' => 429, default => 400 });
    return $result['token'];
}

function emailStatus(array $user): array
{
    $pending = query("SELECT email,expires_at,created_at FROM email_tokens WHERE user_id=? AND purpose='verify' AND used_at IS NULL AND expires_at>? ORDER BY id DESC LIMIT 1", [$user['id'], time()])->fetch();
    return [
        'email' => $user['email'], 'verified' => !empty($user['email_verified_at']), 'verified_at' => $user['email_verified_at'] !== null ? (int)$user['email_verified_at'] : null,
        'pending_email' => $pending ? $pending['email'] : null, 'pending_expires_at' => $pending ? (int)$pending['expires_at'] : null,
        'resend_after' => $pending ? max(0, (int)$pending['created_at'] + 60 - time()) : 0,
        'delivery_configured' => smtpConfigured(),
    ];
}

function emailHandle(string $action, array $input, array $user): array
{
    $userId = (int)$user['id'];
    switch ($action) {
        case 'email.status':
            return emailStatus($user);
        case 'email.set':
            rateLimit('email_set', 5, 3600, (string)$userId);
            requirePassword($user, $input['password'] ?? null);
            $email = emailValue($input['email'] ?? null);
            if ($email === strtolower((string)$user['email']) && $user['email_verified_at']) throw new ApiError('email_unchanged', 409);
            if (query('SELECT 1 FROM users WHERE lower(email)=? AND id<>? AND email_verified_at IS NOT NULL', [$email, $userId])->fetchColumn()) throw new ApiError('email_unavailable', 409);
            transaction(function () use ($userId, $email, $user): void {
                $code = emailIssueCode($userId, $email, 'verify');
                emailQueue($email, $user['locale'], 'verify', ['code' => $code, 'name' => $user['name'], 'minutes' => intdiv(EMAIL_CODE_TTL, 60)]);
            });
            return emailStatus($user);
        case 'email.resend':
            rateLimit('email_resend', 5, 3600, (string)$userId);
            $pending = query("SELECT * FROM email_tokens WHERE user_id=? AND purpose='verify' ORDER BY id DESC LIMIT 1", [$userId])->fetch();
            if (!$pending || ($pending['used_at'] !== null && $user['email_verified_at'] && $pending['email'] === strtolower((string)$user['email']))) throw new ApiError('email_nothing_pending', 409);
            if ((int)$pending['created_at'] > time() - 60) throw new ApiError('email_resend_wait', 429);
            transaction(function () use ($userId, $pending, $user): void {
                $code = emailIssueCode($userId, $pending['email'], 'verify');
                emailQueue($pending['email'], $user['locale'], 'verify', ['code' => $code, 'name' => $user['name'], 'minutes' => intdiv(EMAIL_CODE_TTL, 60)]);
            });
            return emailStatus($user);
        case 'email.verify':
            rateLimit('email_verify', 20, 3600, (string)$userId);
            $token = emailConsumeCode($userId, 'verify', $input['code'] ?? null);
            $old = $user;
            try {
                query('UPDATE users SET email=?,email_verified_at=? WHERE id=?', [$token['email'], time(), $userId]);
            } catch (PDOException $error) {
                if ($error->getCode() === '23505') throw new ApiError('email_unavailable', 409);
                throw $error;
            }
            if (!empty($old['email']) && $old['email_verified_at'] && strtolower($old['email']) !== $token['email']) emailQueue($old['email'], $user['locale'], 'changed', ['name' => $user['name'], 'email' => maskEmail($token['email'])]);
            return emailStatus(query('SELECT * FROM users WHERE id=?', [$userId])->fetch());
        case 'email.unlink_request':
            rateLimit('email_unlink', 5, 3600, (string)$userId);
            requirePassword($user, $input['password'] ?? null);
            if (empty($user['email'])) throw new ApiError('email_not_set', 409);
            if (!$user['email_verified_at']) {
                query('UPDATE users SET email=NULL,email_verified_at=NULL WHERE id=?', [$userId]);
                return emailStatus(query('SELECT * FROM users WHERE id=?', [$userId])->fetch()) + ['unlinked' => true];
            }
            transaction(function () use ($userId, $user): void {
                $code = emailIssueCode($userId, $user['email'], 'unlink');
                emailQueue($user['email'], $user['locale'], 'unlink', ['code' => $code, 'name' => $user['name'], 'minutes' => intdiv(EMAIL_CODE_TTL, 60)]);
            });
            return emailStatus($user) + ['code_sent' => true];
        case 'email.unlink_confirm':
            rateLimit('email_verify', 20, 3600, (string)$userId);
            emailConsumeCode($userId, 'unlink', $input['code'] ?? null);
            query('UPDATE users SET email=NULL,email_verified_at=NULL WHERE id=?', [$userId]);
            return emailStatus(query('SELECT * FROM users WHERE id=?', [$userId])->fetch()) + ['unlinked' => true];
    }
    throw new ApiError('invalid_action', 404);
}

/** Recovery request: identical response whether or not the account exists (no enumeration). */
function authRecoverRequest(array $input): array
{
    rateLimit('recover_ip', 10, 3600);
    $identifier = strtolower(textValue($input['identifier'] ?? '', 254, 3));
    rateLimit('recover_id', 3, 3600, hash('sha256', $identifier));
    $user = str_contains($identifier, '@')
        ? query('SELECT * FROM users WHERE lower(email)=? AND email_verified_at IS NOT NULL', [$identifier])->fetch()
        : query('SELECT * FROM users WHERE username=? AND email_verified_at IS NOT NULL', [ltrim($identifier, '@')])->fetch();
    if ($user) {
        transaction(function () use ($user): void {
            $code = emailIssueCode((int)$user['id'], $user['email'], 'recovery');
            emailQueue($user['email'], $user['locale'], 'recovery', ['code' => $code, 'name' => $user['name'], 'minutes' => intdiv(EMAIL_CODE_TTL, 60)]);
        });
    }
    return ['requested' => true];
}

function authRecoverConfirm(array $input): array
{
    rateLimit('recover_confirm_ip', 30, 3600);
    $identifier = strtolower(textValue($input['identifier'] ?? '', 254, 3));
    rateLimit('recover_confirm_id', 10, 3600, hash('sha256', $identifier));
    $password = passwordValue($input['new_password'] ?? '');
    $user = str_contains($identifier, '@')
        ? query('SELECT * FROM users WHERE lower(email)=? AND email_verified_at IS NOT NULL', [$identifier])->fetch()
        : query('SELECT * FROM users WHERE username=? AND email_verified_at IS NOT NULL', [ltrim($identifier, '@')])->fetch();
    if (!$user) throw new ApiError('email_code_invalid');
    emailConsumeCode((int)$user['id'], 'recovery', $input['code'] ?? null);
    // New password and revocation of every existing session.
    query('UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?', [passwordHash($password), $user['id']]);
    query('DELETE FROM push_subscriptions WHERE user_id=?', [$user['id']]);
    emailNotice($user, 'recovered');
    return ['recovered' => true];
}

/** Claims and sends queued mail. Retries with backoff; gives up after 6 attempts. */
function mailDeliver(int $limit = 20, ?callable $transport = null): array
{
    $stats = ['sent' => 0, 'failed' => 0, 'retry' => 0];
    $transport ??= static fn(array $row) => (new SmtpClient(config()))->send($row['to_email'], $row['subject'], $row['body_text'], $row['body_html']);
    $rows = transaction(fn() => query("UPDATE email_outbox SET status='sending',attempts=attempts+1,lease_until=? WHERE id IN (SELECT id FROM email_outbox WHERE (status='queued' AND available_at<=?) OR (status='sending' AND lease_until<?) ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED) RETURNING *", [time() + 120, time(), time(), $limit])->fetchAll());
    foreach ($rows as $row) {
        try {
            $transport($row);
            query("UPDATE email_outbox SET status='sent',sent_at=?,last_error=NULL WHERE id=?", [time(), $row['id']]);
            $stats['sent']++;
        } catch (Throwable $error) {
            $attempts = (int)$row['attempts'];
            $final = $attempts >= 6;
            $delay = [60, 300, 900, 3600, 21600][$attempts - 1] ?? 21600;
            query('UPDATE email_outbox SET status=?,available_at=?,last_error=? WHERE id=?', [$final ? 'failed' : 'queued', time() + $delay, substr(preg_replace('/[^\w .:-]/', '', $error->getMessage()), 0, 200), $row['id']]);
            $stats[$final ? 'failed' : 'retry']++;
        }
    }
    // Delivered mail bodies contain one-time codes: keep only short-lived history.
    query("DELETE FROM email_outbox WHERE status IN ('sent','failed') AND created_at<?", [time() - 7 * 86400]);
    return $stats;
}

/** Minimal SMTP client: implicit TLS or STARTTLS, AUTH PLAIN/LOGIN, multipart/alternative. */
final class SmtpClient
{
    private $socket;

    public function __construct(private array $config) {}

    public function send(string $to, string $subject, string $text, string $html): void
    {
        $host = (string)$this->config['smtp_host'];
        $port = (int)($this->config['smtp_port'] ?? 587);
        $secure = (string)($this->config['smtp_secure'] ?? 'tls');
        $context = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $host]]);
        $this->socket = @stream_socket_client(($secure === 'ssl' ? 'ssl://' : 'tcp://') . $host . ':' . $port, $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $context);
        if (!$this->socket) throw new RuntimeException('smtp_connect_failed ' . $errno);
        stream_set_timeout($this->socket, 20);
        try {
            $this->expect([220]);
            $domain = preg_replace('/[^a-z0-9.-]/i', '', (string)($this->config['smtp_helo'] ?? gethostname() ?: 'localhost'));
            $this->command('EHLO ' . $domain, [250]);
            if ($secure === 'tls') {
                $this->command('STARTTLS', [220]);
                if (!stream_socket_enable_crypto($this->socket, true, STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT)) throw new RuntimeException('smtp_tls_failed');
                $this->command('EHLO ' . $domain, [250]);
            }
            if (!empty($this->config['smtp_user'])) {
                $this->command('AUTH PLAIN ' . base64_encode("\0" . $this->config['smtp_user'] . "\0" . ($this->config['smtp_password'] ?? '')), [235]);
            }
            $from = self::address((string)$this->config['mail_from']);
            $to = self::address($to);
            $this->command('MAIL FROM:<' . $from . '>', [250]);
            $this->command('RCPT TO:<' . $to . '>', [250, 251]);
            $this->command('DATA', [354]);
            $this->write(self::message($from, (string)($this->config['mail_from_name'] ?? 'PingUp'), $to, $subject, $text, $html) . "\r\n.");
            $this->expect([250]);
            $this->command('QUIT', [221]);
        } finally {
            fclose($this->socket);
        }
    }

    public static function address(string $address): string
    {
        if (preg_match('/[\r\n<>]/', $address) || !filter_var($address, FILTER_VALIDATE_EMAIL)) throw new RuntimeException('smtp_invalid_address');
        return $address;
    }

    public static function header(string $value): string
    {
        return '=?UTF-8?B?' . base64_encode(str_replace(["\r", "\n"], ' ', $value)) . '?=';
    }

    public static function message(string $from, string $fromName, string $to, string $subject, string $text, string $html): string
    {
        $boundary = 'pingup-' . bin2hex(random_bytes(12));
        $domain = substr(strrchr($from, '@'), 1);
        $headers = [
            'Date: ' . gmdate('D, d M Y H:i:s') . ' +0000',
            'From: ' . self::header($fromName) . ' <' . $from . '>',
            'To: <' . $to . '>',
            'Subject: ' . self::header($subject),
            'Message-ID: <' . bin2hex(random_bytes(16)) . '@' . $domain . '>',
            'MIME-Version: 1.0',
            'Auto-Submitted: auto-generated',
            'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
        ];
        $body = '--' . $boundary . "\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($text))
            . '--' . $boundary . "\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($html))
            . '--' . $boundary . '--';
        // Base64 bodies never start a line with '.', so no dot-stuffing is needed.
        return implode("\r\n", $headers) . "\r\n\r\n" . $body;
    }

    private function command(string $line, array $codes): void
    {
        $this->write($line);
        $this->expect($codes);
    }

    private function write(string $data): void
    {
        if (fwrite($this->socket, $data . "\r\n") === false) throw new RuntimeException('smtp_write_failed');
    }

    private function expect(array $codes): void
    {
        $response = '';
        while (($line = fgets($this->socket, 1024)) !== false) {
            $response .= $line;
            if (strlen($line) < 4 || $line[3] === ' ') break;
        }
        $code = (int)substr($response, 0, 3);
        if (!in_array($code, $codes, true)) throw new RuntimeException('smtp_unexpected_' . $code);
    }
}
