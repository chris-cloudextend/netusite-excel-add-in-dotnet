# Making Your Add-in Visible in Excel Developer Add-ins (Mac)

You have multiple manifests in your WEF folder (e.g. `manifest-fre-chris.xml`, `manifest-fre-staging`). Excel only shows **one entry per unique add-in Id**. If your build doesn’t appear, it’s usually because it shares the same `<Id>` as another manifest or Excel hasn’t rescanned the folder.

## 1. Use a unique Id and display name for your build

Excel distinguishes add-ins by the **`<Id>`** in the manifest (a GUID), not by the filename. The **`<DisplayName>`** is what you see in the list.

- If `manifest-fre-chris.xml` has the **same `<Id>`** as `manifest-fre-staging`, Excel treats them as the same add-in and only one will show.
- To see yours as a **separate** add-in:
  - Give `manifest-fre-chris.xml` a **different `<Id>`** (e.g. generate a new GUID).
  - Optionally set a **different `<DisplayName>`** (e.g. `XAVI for NetSuite (Chris)` or `XAVI - Tunnel`) so you can tell them apart.

**Example:** In `manifest-fre-chris.xml`, change:

```xml
<Id>c3d4e5f6-7890-12ab-cdef-345678901cde</Id>
...
<DisplayName DefaultValue="XAVI for NetSuite"/>
```

to (use your own new GUID):

```xml
<Id>a1b2c3d4-5678-90ab-cdef-111111111111</Id>
...
<DisplayName DefaultValue="XAVI for NetSuite (Chris)"/>
```

You can generate a new GUID at https://www.guidgenerator.com/ or run `uuidgen` in Terminal.

## 2. Put the manifest in the WEF folder and restart Excel

- **WEF folder on Mac:**  
  `~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/`

- Copy your manifest (e.g. `manifest-fre-chris.xml`) into that folder.
- **Quit Excel completely** (Cmd+Q), then reopen Excel.
- Check **Insert → My Add-ins → Developer Add-ins** (or **Shared Folder** if that’s where your org points to the WEF folder). Your add-in should appear with the new display name.

## 3. If it still doesn’t show

- **Re-scan:** In Excel, go to **Insert → My Add-ins → Shared Folder** and confirm the path is your WEF folder; select the manifest if prompted.
- **Validate manifest:** Open `manifest-fre-chris.xml` in a browser or validator; fix any XML errors so Excel doesn’t skip it.
- **Clear WEF cache (optional):** From the repo run  
  `./excel-addin/useful-commands/clear-excel-cache.sh`, then copy the manifest into the WEF folder again and restart Excel.

## 4. Server, tunnel, and Cloudflare worker (when to restart)

- **Seeing the add-in in the list** only depends on the manifest file in the WEF folder and a unique Id (and restarting Excel). It does **not** depend on the backend server, tunnel, or Cloudflare worker.
- **Using the add-in** (formulas, task pane, API calls) does depend on:
  - Your .NET server running.
  - Tunnel running (if the add-in points at the tunnel).
  - Cloudflare worker updated to point at the current tunnel URL (if you use the worker).

So: you do **not** need to restart the server just to make the add-in **visible**. After you start the tunnel and update the Cloudflare worker, you only need to restart the server if you changed backend code or config; the add-in will then use the current tunnel/worker when it runs.

**Summary:** Give `manifest-fre-chris.xml` a **unique `<Id>`** (and a distinct `<DisplayName>` if you like), put it in the WEF folder, **restart Excel**. Use the server/tunnel/worker when you actually run and test the add-in; no server restart is required just to see it in the list.
