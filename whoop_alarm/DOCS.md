# WHOOP Wecker Sync — Add-on

Synchronisiert die Home-Assistant-Weckzeit mit dem WHOOP **Smart Alarm**
(Schlafplaner-Wecker), damit dein WHOOP-Band morgens vibriert.

## Wie es funktioniert

Das Add-on stellt eine kleine HTTP-API bereit. Eine HA-Automation ruft sie auf,
wenn sich deine Weckzeit (`input_datetime.weckzeit`) oder dein Alarm-Schalter
(`input_boolean.alarm`) ändert. Das Add-on schreibt die Zeit dann in WHOOP.

Technisch: Es setzt die `preferences` des WHOOP Smart Alarm
(`upper_time_bound` = Weckzeit, `enabled` = an/aus) per privater WHOOP-iOS-API.
Die Zeitzone wird von WHOOP automatisch gepflegt (read-modify-write), daher
funktioniert es auch im Ausland.

## Konfiguration

| Option | Pflicht | Beschreibung |
|---|---|---|
| `whoop_refresh_token` | ja | WHOOP-Cognito-Refresh-Token (einmalig per Login erzeugt). Das Add-on hält ihn selbst frisch. |
| `timezone` | nein | IANA-Zeitzone, Standard `Europe/Berlin`. |
| `auth_token` | nein | Wenn gesetzt: Jeder API-Aufruf muss den Header `x-auth-token` mitschicken (Schutz im Heimnetz). |

## API

- `GET /health` → `{ "ok": true }`
- `GET /alarm` → aktueller Wecker `{ "time": "07:00:00", "enabled": true, ... }`
- `POST /set-alarm` mit Body `{ "time": "07:00", "enabled": true }` → setzt den Wecker.
  `enabled` ist optional; fehlt es, bleibt der aktuelle An/Aus-Status erhalten.

Erreichbar unter `http://<green-ip>:9590` bzw. dem in HA gemappten Port.

## Refresh-Token erzeugen

Einmalig mit dem Login-Skript aus dem Projekt (`poc/whoop-inspect.mjs`) anmelden;
der Token landet in `poc/.whoop-tokens.json` (Feld `refreshToken`). Diesen Wert in
die Add-on-Option `whoop_refresh_token` eintragen.
