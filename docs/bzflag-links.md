# Opening `bzflag://` links

`/list` gives every BZFlag server a **Launch** link, `bzflag://host:port`,
which opens that server in an installed BZFlag client. A browser can only
follow one if the system knows what handles `bzflag://`, and BZFlag's own
installers do not register it. This is how to, once per machine.

## Why a wrapper

The client does not take a URL. Its last argument is
`[callsign[:password]@]server[:port]` (`bzflag.cxx:431`), so handed
`bzflag://example.org:5154` it reads the port and takes `bzflag://example.org`
as the server name. Every handler below therefore strips `bzflag://` (and any
trailing `/` a browser adds) and passes what is left.

## Linux

A desktop entry for the scheme, in `~/.local/share/applications/bzflag-url.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=BZFlag (link)
Exec=sh -c 'u="${1#bzflag://}"; exec bzflag "${u%/}"' sh %u
MimeType=x-scheme-handler/bzflag;
NoDisplay=true
```

Then make it the handler:

```bash
xdg-mime default bzflag-url.desktop x-scheme-handler/bzflag
update-desktop-database ~/.local/share/applications
```

`bzflag` has to be on `PATH`; a client built or unpacked elsewhere wants its
full path in `Exec` instead.

## Windows

A small script the link calls, saved as `C:\Games\bzflag-url.cmd` (any folder
will do, as long as the registry entry below names the same one):

```bat
@echo off
set "u=%~1"
set "u=%u:bzflag://=%"
if "%u:~-1%"=="/" set "u=%u:~0,-1%"
start "" "C:\Program Files\BZFlag 2.4.26 64Bit\bzflag.exe" %u%
```

The `bzflag.exe` path is the installer's default folder, `BZFlag <version>`
under Program Files with the bitness after it on a 64-bit install; match it to
yours. Then register the scheme for your account -- save this as
`bzflag-url.reg` and double-click it:

```reg
Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\Software\Classes\bzflag]
@="URL:BZFlag server"
"URL Protocol"=""

[HKEY_CURRENT_USER\Software\Classes\bzflag\shell\open\command]
@="\"C:\\Games\\bzflag-url.cmd\" \"%1\""
```

`HKEY_CURRENT_USER` needs no administrator rights and touches no one else's
account.

## macOS

macOS hands a URL scheme only to an application that declares it, so the
handler is a tiny app:

1. In **Script Editor**, a new script:

   ```applescript
   on open location target
       set server to text 10 thru -1 of target
       if server ends with "/" then set server to text 1 thru -2 of server
       do shell script "open -n -a BZFlag --args " & quoted form of server
   end open location
   ```

   (`text 10 thru -1` drops the nine characters of `bzflag://`.) Save it as an
   **Application**, say `~/Applications/BZFlag Link.app`.
2. Declare the scheme: open `BZFlag Link.app/Contents/Info.plist` in a text
   editor and add, inside the top-level `<dict>`:

   ```xml
   <key>CFBundleURLTypes</key>
   <array>
     <dict>
       <key>CFBundleURLName</key>
       <string>BZFlag server</string>
       <key>CFBundleURLSchemes</key>
       <array><string>bzflag</string></array>
     </dict>
   </array>
   ```

3. Open `BZFlag Link.app` once from the Finder, so macOS notices it.

`-a BZFlag` finds the client by its application name; if yours is named for
its version (`BZFlag-2.4.26.app`), use that name instead.

## Checking it

Open a terminal and hand the system a link, as a browser would:

```bash
xdg-open bzflag://bz.rikers.org:5154        # Linux
open bzflag://bz.rikers.org:5154            # macOS
start bzflag://bz.rikers.org:5154           # Windows, in cmd
```

The client should start and connect. A browser asks the first time whether to
open the link with it; allowing that for the site is what makes **Launch**
one click afterwards.
