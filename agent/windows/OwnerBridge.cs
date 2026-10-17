using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Globalization;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

sealed class OwnerBridge
{
    static readonly byte[] Entropy = Encoding.UTF8.GetBytes("LocalCommander-v1 CurrentUser");
    const int MaxJson = 400000;
    const int MaxData = 262144;

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "read-prefix")
            {
                int limit;
                if (!Int32.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out limit) || limit < 1 || limit > 16777216) return Fail("ARGUMENT_INVALID");
                return ReadFile(limit, true);
            }
            if (args.Length != 1) return Fail("ARGUMENT_INVALID");
            switch (args[0])
            {
                case "protect": return Crypt(true);
                case "unprotect": return Crypt(false);
                case "choose-folder": return ChooseFolder();
                case "choose-access": return ChooseAccess();
                case "init-directory": return InitDirectory();
                case "guard-review": return GuardReview();
                case "read-file": return ReadFile(1048576, false);
                default: return Fail("ARGUMENT_INVALID");
            }
        }
        catch (CryptographicException) { return Fail("DPAPI_FAILED"); }
        catch (UnauthorizedAccessException) { return Fail("ACCESS_DENIED"); }
        catch (IOException) { return Fail("IO_FAILED"); }
        catch { return Fail("BRIDGE_FAILED"); }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder name, uint length, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint GetFileType(SafeFileHandle file);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint QueryDosDevice(string device, StringBuilder target, uint length);

    // Network and subst letters resolve to a different canonical path, which grant validation rejects.
    static bool LocalDriveRoot(DriveInfo drive, string root)
    {
        if (drive.DriveType != DriveType.Fixed && drive.DriveType != DriveType.Removable) return false;
        var target = new StringBuilder(1024);
        if (QueryDosDevice(root.Substring(0, 2), target, (uint)target.Capacity) == 0) return false;
        return !target.ToString().StartsWith(@"\??\", StringComparison.Ordinal);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileTime(SafeFileHandle file, out long created, out long accessed, out long written);

    static bool SameOpenedPath(FileStream file, string expected)
    {
        var name = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(file.SafeFileHandle, name, (uint)name.Capacity, 0);
        if (length == 0 || length >= name.Capacity) return false;
        string actual = name.ToString();
        if (actual.StartsWith(@"\\?\UNC\", StringComparison.Ordinal)) actual = @"\\" + actual.Substring(8);
        else if (actual.StartsWith(@"\\?\", StringComparison.Ordinal)) actual = actual.Substring(4);
        // The caller supplies realpath's canonical spelling; ambiguity fails closed.
        return String.Equals(actual, expected, StringComparison.Ordinal);
    }

    static int ReadFile(int limit, bool prefix)
    {
        string target = Unescape(Extract(ReadBounded(), "path"));
        if (target.Length > 32760 || HasControl(target) || !Path.IsPathRooted(target) ||
            target.StartsWith(@"\\?\") || target.StartsWith(@"\\.\") || target.IndexOf(':', 2) >= 0 ||
            !String.Equals(target, Path.GetFullPath(target), StringComparison.Ordinal)) return Fail("PATH_INVALID");
        try
        {
            // No write/delete sharing: bytes and final path come from this one handle.
            using (var file = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (GetFileType(file.SafeFileHandle) != 1 || !SameOpenedPath(file, target)) return Fail("FILE_CHANGED");
                long size = file.Length, created, accessed, written;
                if (!GetFileTime(file.SafeFileHandle, out created, out accessed, out written)) return Fail("IO_FAILED");
                if (!prefix && size > limit) return Fail("FILE_UNSUPPORTED_OR_TOO_LARGE");
                byte[] bytes = new byte[(int)Math.Min(size, limit)];
                int count = 0;
                while (count < bytes.Length)
                {
                    int read = file.Read(bytes, count, bytes.Length - count);
                    if (read == 0) break;
                    count += read;
                }
                long finalWritten;
                if (count != bytes.Length || file.Length != size || !SameOpenedPath(file, target) ||
                    !GetFileTime(file.SafeFileHandle, out created, out accessed, out finalWritten) || finalWritten != written) return Fail("FILE_CHANGED");
                if (prefix)
                    Console.Out.Write("{\"data\":\"" + Convert.ToBase64String(bytes) + "\",\"size\":" + size.ToString(CultureInfo.InvariantCulture) +
                        ",\"modifiedAt\":\"" + DateTime.FromFileTimeUtc(written).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) +
                        "\",\"truncated\":" + (size > limit ? "true" : "false") + "}");
                else using (Stream output = Console.OpenStandardOutput()) output.Write(bytes, 0, count);
                return 0;
            }
        }
        catch (FileNotFoundException) { return Fail("ENOENT"); }
        catch (DirectoryNotFoundException) { return Fail("ENOENT"); }
    }

    static int Crypt(bool protect)
    {
        string encoded = Extract(ReadBounded(), "data");
        if (!Regex.IsMatch(encoded, "^[A-Za-z0-9+/]*={0,2}$")) return Fail("INPUT_INVALID");
        byte[] data;
        try { data = Convert.FromBase64String(encoded); } catch { return Fail("INPUT_INVALID"); }
        if (Convert.ToBase64String(data) != encoded) return Fail("INPUT_INVALID");
        if (data.Length > MaxData) return Fail("INPUT_TOO_LARGE");
        byte[] result = protect
            ? ProtectedData.Protect(data, Entropy, DataProtectionScope.CurrentUser)
            : ProtectedData.Unprotect(data, Entropy, DataProtectionScope.CurrentUser);
        if (result.Length > MaxData * 4) return Fail("OUTPUT_TOO_LARGE");
        Console.Out.Write("{\"data\":\"" + Convert.ToBase64String(result) + "\"}");
        return 0;
    }

    // Kept separate for headless construction/accessibility regression checks; no test approval mode.
    static Form CreateGuardReview(string summary)
    {
        var form = new Form();
        form.Text = "Local Commander - review action";
        form.Width = 840; form.Height = 660;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.TopMost = true;
        form.Shown += (sender, e) => form.Activate();
        form.MinimizeBox = false; form.MaximizeBox = false;
        var details = new TextBox { Name = "guard-summary", Multiline = true, ReadOnly = true,
            WordWrap = false, ScrollBars = ScrollBars.Both, Dock = DockStyle.Fill,
            Text = summary, AccessibleName = "Exact action and approval scope", TabIndex = 0 };
        var panel = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 95, FlowDirection = FlowDirection.LeftToRight };
        var reviewed = new CheckBox { Name = "reviewed", Text = "I reviewed the action, scope and expiry", AutoSize = true, TabIndex = 1 };
        panel.SetFlowBreak(reviewed, true);
        var deny = new Button { Name = "reject", Text = "Reject", DialogResult = DialogResult.Cancel, AutoSize = true, TabIndex = 2 };
        var approve = new Button { Name = "approve", Text = "Approve / Continue", Enabled = false, DialogResult = DialogResult.OK, AutoSize = true, TabIndex = 3 };
        reviewed.CheckedChanged += (sender, e) => { approve.Enabled = reviewed.Checked; };
        panel.Controls.Add(reviewed); panel.Controls.Add(deny); panel.Controls.Add(approve);
        form.Controls.Add(details); form.Controls.Add(panel);
        form.AcceptButton = deny; form.CancelButton = deny;
        return form;
    }
    static int GuardReview()
    {
        if (!Environment.UserInteractive) return Fail("HEADLESS_DIALOG");
        byte[] bytes = Convert.FromBase64String(Extract(ReadBounded(), "data"));
        if (bytes.Length < 1 || bytes.Length > 200000) return Fail("INPUT_TOO_LARGE");
        string summary = new UTF8Encoding(false, true).GetString(bytes);
        Application.EnableVisualStyles();
        using (var form = CreateGuardReview(summary))
        {
            bool approved = form.ShowDialog() == DialogResult.OK;
            string sid = WindowsIdentity.GetCurrent().User.Value;
            Console.Out.Write("{\"approved\":" + (approved ? "true" : "false") + ",\"ownerSid\":\"" + JsonString(sid) + "\"}");
        }
        return 0;
    }

    // Construction can be tested without showing a dialog or granting real access.
    static Form CreateAccessChoice(string drives)
    {
        var form = new Form();
        form.Text = "Local Commander - choose access";
        form.Width = 720; form.Height = 460;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.MinimizeBox = false; form.MaximizeBox = false;
        var details = new Label { Name = "access-summary", Dock = DockStyle.Fill, AutoSize = false,
            Padding = new Padding(18), Text =
            "Choose access for your connected AI through Local Commander (localcmd.app).\n\n" +
            "Full access (default): read and write accessible files on " + (drives.Length == 0 ? "no available local drives" : drives) + ", run installed commands and access localhost services. Programs run with your Windows account's rights and may access resources outside the selected working folder. This is not an OS sandbox. No folder picker follows.\n\n" +
            "Selected folders: choose one folder; it is read and write. Add more folders later, or turn writing off with deny-write.\n\n" +
            "Windows permissions, protected Local Commander file tools and secret-file filters remain. Selected folders require separate command/localhost permissions. This choice replaces existing grants and their restrictions. Updates preserve existing choices.\n\n" +
            "Only the local drive letters shown above are included (not network or subst drives). To include a new or previously unavailable drive, run configure-access again." };
        var panel = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 120,
            Padding = new Padding(18, 0, 18, 0), FlowDirection = FlowDirection.TopDown, WrapContents = false };
        var folders = new Button { Name = "folders", Text = "Restrict to selected folders", AutoSize = true, DialogResult = DialogResult.No, TabIndex = 1 };
        var all = new Button { Name = "all-drives", Text = "Full access - all connected drives (default)", AutoSize = true, Enabled = drives.Length > 0, DialogResult = DialogResult.Yes, TabIndex = 0 };
        var cancel = new Button { Name = "cancel", Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel, TabIndex = 2 };
        panel.Controls.Add(all); panel.Controls.Add(folders); panel.Controls.Add(cancel);
        form.Controls.Add(details); form.Controls.Add(panel);
        form.AcceptButton = drives.Length > 0 ? all : folders; form.CancelButton = cancel;
        return form;
    }
    static int ChooseAccess()
    {
        if (!Environment.UserInteractive) return Fail("HEADLESS_DIALOG");
        Application.EnableVisualStyles();
        var drives = new System.Collections.Generic.List<string>();
        foreach (var drive in DriveInfo.GetDrives())
        {
            try {
                string root = drive.RootDirectory.FullName;
                if (drive.IsReady && Regex.IsMatch(root, @"^[A-Za-z]:\\$") && LocalDriveRoot(drive, root) && Directory.Exists(root)) drives.Add(root);
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
        drives.Sort(StringComparer.OrdinalIgnoreCase);
        using (var choice = CreateAccessChoice(String.Join(", ", drives.ToArray())))
        {
            DialogResult result = choice.ShowDialog();
            if (result == DialogResult.Yes && drives.Count > 0)
            {
                var json = new StringBuilder("{\"mode\":\"all-drives\",\"paths\":[");
                for (int i = 0; i < drives.Count; i++) {
                    if (i > 0) json.Append(',');
                    json.Append('"').Append(JsonString(drives[i])).Append('"');
                }
                Console.Out.Write(json.Append("]}").ToString());
                return 0;
            }
            if (result == DialogResult.No)
            {
                using (var dialog = new FolderBrowserDialog())
                {
                    dialog.Description = "Choose a Local Commander folder (read and write)";
                    dialog.ShowNewFolderButton = true;
                    if (dialog.ShowDialog() == DialogResult.OK && !String.IsNullOrWhiteSpace(dialog.SelectedPath)) {
                        Console.Out.Write("{\"mode\":\"folders\",\"paths\":[\"" + JsonString(Path.GetFullPath(dialog.SelectedPath)) + "\"]}");
                        return 0;
                    }
                }
            }
            Console.Out.Write("{\"mode\":\"cancelled\",\"paths\":[]}");
        }
        return 0;
    }

    static int ChooseFolder()
    {
        if (!Environment.UserInteractive) return Fail("HEADLESS_DIALOG");
        Application.EnableVisualStyles();
        using (var dialog = new FolderBrowserDialog())
        {
            dialog.Description = "Choose a Local Commander folder (read and write)";
            dialog.ShowNewFolderButton = true;
            DialogResult result = dialog.ShowDialog();
            if (result == DialogResult.OK && !String.IsNullOrWhiteSpace(dialog.SelectedPath))
                Console.Out.Write("{\"path\":\"" + JsonString(Path.GetFullPath(dialog.SelectedPath)) + "\"}");
            else
                Console.Out.Write("{\"path\":null}");
        }
        return 0;
    }

    static int InitDirectory()
    {
        string raw = Extract(ReadBounded(), "path");
        if (String.IsNullOrWhiteSpace(raw) || HasControl(raw)) return Fail("PATH_INVALID");
        string target = Path.GetFullPath(Unescape(raw));
        if (!Path.IsPathRooted(target) || !AllowedDirectory(target) || HasReparsePointInExistingChain(target)) return Fail("PATH_INVALID");

        bool existed = Directory.Exists(target);
        if (existed)
        {
            var info = new DirectoryInfo(target);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0) return Fail("PATH_REPARSE_POINT");
            string[] names = Directory.GetFileSystemEntries(target);
            bool marker = File.Exists(Path.Combine(target, "owner-state.marker"));
            if (names.Length > 0 && !marker) return Fail("PATH_UNKNOWN");
            foreach (string entry in names)
            {
                string name = Path.GetFileName(entry);
                bool memoryFile = name == "host-memory.json" || Regex.IsMatch(name, @"\Ahost-memory\.json\.[1-9][0-9]{0,9}\.tmp\z");
                if (memoryFile)
                {
                    FileAttributes attributes = File.GetAttributes(entry);
                    if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0 || new FileInfo(entry).Length > 32768) return Fail("PATH_INVALID");
                }
                if (!memoryFile && name != "owner-state.marker" && name != "owner-state.dat" && name != "owner-state.lock" && name != "journal" && name != "agent-process.json" && name != "optimization" && name != ".local-commander")
                    return Fail("PATH_UNKNOWN");
                if (name == "agent-process.json" || name == "optimization" || name == ".local-commander")
                {
                    FileAttributes attributes = File.GetAttributes(entry);
                    if ((attributes & FileAttributes.ReparsePoint) != 0) return Fail("PATH_REPARSE_POINT");
                    bool isDirectory = (attributes & FileAttributes.Directory) != 0;
                    if (name != "agent-process.json" ? !isDirectory : isDirectory) return Fail("PATH_INVALID");
                    if (name == "agent-process.json" && (new FileInfo(entry).Length < 1 || new FileInfo(entry).Length > 8192)) return Fail("PATH_INVALID");
                }
            }
        }
        else Directory.CreateDirectory(target);

        var directory = new DirectoryInfo(target);
        if ((directory.Attributes & FileAttributes.ReparsePoint) != 0) return Fail("PATH_REPARSE_POINT");
        SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
        SecurityIdentifier system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        DirectorySecurity security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        directory.SetAccessControl(security);
        if (!RecoverAbandonedJournalLock(target)) return Fail("JOURNAL_LOCK_INVALID");
        Console.Out.Write("{\"ok\":true}");
        return 0;
    }

    static bool RecoverAbandonedJournalLock(string stateDirectory)
    {
        string lockPath = Path.Combine(stateDirectory, "journal", "journal.lock");
        if (!File.Exists(lockPath)) return true;
        if (HasReparsePointInExistingChain(lockPath) || (File.GetAttributes(lockPath) & FileAttributes.ReparsePoint) != 0) return false;
        FileStream file;
        // Deny concurrent readers/writers while allowing our atomic rename. An
        // active journal or another recovery owns the handle: leave it alone.
        try { file = new FileStream(lockPath, FileMode.Open, FileAccess.Read, FileShare.Delete); }
        catch (FileNotFoundException) { return true; }
        catch (IOException error) { if ((error.HResult & 0xffff) == 32 || (error.HResult & 0xffff) == 33) return true; throw; }
        string abandoned;
        using (file)
        {
            if (!SameOpenedPath(file, lockPath) || file.Length < 1 || file.Length > 1024) return false;
            string json;
            using (var reader = new StreamReader(file, new UTF8Encoding(false, true), false, 1024, true)) json = reader.ReadToEnd();
            var match = Regex.Match(json, @"\A\{""pid"":([1-9][0-9]*),""nonce"":""[a-f0-9]{32}"",""createdAt"":""([^""]+)""\}\z");
            int pid; DateTimeOffset createdAt;
            if (!match.Success || !Int32.TryParse(match.Groups[1].Value, out pid) ||
                !DateTimeOffset.TryParseExact(match.Groups[2].Value, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out createdAt)) return false;
            try { using (var owner = System.Diagnostics.Process.GetProcessById(pid)) { if (!owner.HasExited) return true; } }
            catch (ArgumentException) { /* The recorded process no longer exists. */ }
            abandoned = lockPath + ".abandoned." + Guid.NewGuid().ToString("N");
            File.Move(lockPath, abandoned);
        }
        // Only the claimed transient lock is removed; never any journal entry.
        File.Delete(abandoned);
        return true;
    }

    static bool AllowedDirectory(string target)
    {
        string local = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
        string app = Path.Combine(local, "LocalCommander");
        string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
        if (IsChild(target, app)) return true;
        if (IsChild(target, temp) && Regex.IsMatch(Path.GetFileName(target), "^lc-private-[A-Za-z0-9_.-]+$", RegexOptions.IgnoreCase)) return true;
        return false;
    }

    static bool IsChild(string child, string parent)
    {
        string p = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string c = Path.GetFullPath(child);
        return c.StartsWith(p, StringComparison.OrdinalIgnoreCase);
    }

    static bool HasReparsePointInExistingChain(string target)
    {
        string current = Path.GetFullPath(target);
        while (!Directory.Exists(current))
        {
            string parent = Path.GetDirectoryName(current);
            if (String.IsNullOrEmpty(parent) || parent == current) return true;
            current = parent;
        }
        while (true)
        {
            var info = new DirectoryInfo(current);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0) return true;
            string parent = info.Parent == null ? null : info.Parent.FullName;
            if (String.IsNullOrEmpty(parent) || parent == current) break;
            current = parent;
        }
        return false;
    }

    static string ReadBounded()
    {
        using (Stream input = Console.OpenStandardInput())
        using (var memory = new MemoryStream())
        {
            byte[] buffer = new byte[8192];
            for (;;)
            {
                int read = input.Read(buffer, 0, buffer.Length);
                if (read == 0) break;
                memory.Write(buffer, 0, read);
                if (memory.Length > MaxJson) throw new InvalidDataException();
            }
            return new UTF8Encoding(false, true).GetString(memory.ToArray());
        }
    }

    static string Extract(string json, string name)
    {
        Match match = Regex.Match(json, "^\\s*\\{\\s*\\\"" + name + "\\\"\\s*:\\s*\\\"((?:[^\\\"\\\\]|\\\\.)*)\\\"\\s*\\}\\s*$");
        if (!match.Success) throw new InvalidDataException();
        return match.Groups[1].Value;
    }

    static string Unescape(string value)
    {
        var output = new StringBuilder(value.Length);
        for (int i = 0; i < value.Length; i++)
        {
            char ch = value[i];
            if (ch != '\\') { output.Append(ch); continue; }
            if (++i >= value.Length) throw new InvalidDataException();
            char escaped = value[i];
            if (escaped == '\\' || escaped == '"') output.Append(escaped);
            else throw new InvalidDataException();
        }
        return output.ToString();
    }

    static bool HasControl(string value)
    {
        foreach (char ch in value) if (ch < 0x20 || ch == 0x7f) return true;
        return false;
    }

    static string JsonString(string value)
    {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    }

    static int Fail(string code)
    {
        Console.Error.Write("{\"error\":\"" + code + "\"}");
        return 1;
    }
}
