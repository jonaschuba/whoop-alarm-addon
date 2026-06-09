# WHOOP Wecker Sync — Home Assistant Add-on

Synct die Home-Assistant-Weckzeit mit dem **WHOOP Smart Alarm**, damit dein
WHOOP-Band morgens vibriert. Kein offizielles WHOOP-Produkt — nutzt die private
WHOOP-iOS-API (read-modify-write der Smart-Alarm-`preferences`).

## Installation

1. In Home Assistant: **Einstellungen → Add-ons → Add-on Store → ⋮ → Repositories**
   und diese URL hinzufügen:
   ```
   https://github.com/jonaschuba/whoop-alarm-addon
   ```
2. Das Add-on **„WHOOP Wecker Sync"** installieren.
3. Unter **Konfiguration** den `whoop_refresh_token` eintragen (siehe
   [whoop_alarm/DOCS.md](whoop_alarm/DOCS.md)) und starten.

## Was es macht

Stellt eine HTTP-API bereit (`POST /set-alarm`), die eine HA-Automation aufruft.
Details: [whoop_alarm/DOCS.md](whoop_alarm/DOCS.md).

> ⚠️ Nutzt eine inoffizielle WHOOP-API. Auf eigene Verantwortung; kann bei
> WHOOP-App-Updates brechen.
