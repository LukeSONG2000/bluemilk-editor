using System.Security.Cryptography;
using System.Text.Json;
using System.Diagnostics;
using Swgoh.Client;

if (args.Length == 2 && args[0] is ("--prepare-update" or "--prepare-update-cancel"))
{
    try {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(args[0] == "--prepare-update-cancel" ? 1 : 30));
        using var lease = await UpdatePreparation.AcquireAsync(args[1], deadline.Token);
        Console.WriteLine("prepared");
        await Console.In.ReadLineAsync();
    } catch (Exception error) {
        Console.Error.WriteLine(error.GetType().Name);
        Environment.ExitCode = 2;
    }
    return;
}

if (args.Length == 2 && args[0] == "--update-lease")
{
    try {
        using var lease = new UpdateLease(args[1]);
        Console.WriteLine("held");
        await Console.In.ReadLineAsync();
    } catch (IOException) { Environment.ExitCode = 2; }
    return;
}

if (args.Length == 2 && args[0] == "--endpoint-start")
{
    var endpoint = await ServerLauncher.EnsureAsync(args[1]);
    using var connection = await SharedConnection.OpenAsync(endpoint.Uri, endpoint.Token, endpoint.Instance, endpoint.Pid);
    Console.WriteLine(JsonSerializer.Serialize(new { pid = connection.HostPid, instance = endpoint.Instance }));
    return;
}

if (args.Length == 2 && args[0] is ("--endpoint-probe" or "--endpoint-idle"))
{
    try {
    var endpoint = ServerEndpoint.Read(args[1]);
    if (endpoint == null) { Console.WriteLine("{\"found\":false}"); return; }
    using var connection = await SharedConnection.OpenAsync(endpoint.Uri, endpoint.Token, endpoint.Instance, endpoint.Pid);
    if (args[0] == "--endpoint-idle") await Task.Delay(2500);
    var capabilities = await connection.RequestAsync("capabilities", null);
    Console.WriteLine(JsonSerializer.Serialize(new { found = true, hostPid = connection.HostPid,
        protocol = capabilities.GetProperty("protocol").GetString() }));
    } catch (Exception error) {
        // Invalid endpoint fixtures are expected errors, not application crashes.
        // Avoid invoking Windows crash reporting and never print credentials.
        Console.Error.WriteLine(error.GetType().Name);
        Environment.ExitCode = 1;
    }
    return;
}

if (args.Length == 2 && args[0] == "--verify-package")
{
    using var packageRecord = JsonDocument.Parse(File.ReadAllText(args[1] + ".json"));
    var packageData = packageRecord.RootElement;
    var packageToVerify = new ReleasePackage(Version.Parse(packageData.GetProperty("version").GetString()!),
        Path.GetFileName(args[1]), new Uri("https://api.github.com/repos/" + ReleaseUpdates.Repository + "/releases/assets/1"),
        new FileInfo(args[1]).Length, packageData.GetProperty("sha256").GetString()!);
    await PackageDownloads.VerifyAsync(args[1], packageToVerify);
    if (packageData.TryGetProperty("signed", out var signedFlag) && signedFlag.GetBoolean())
        MsixIdentity.ReadAndValidate(args[1], packageToVerify.Version, packageData.GetProperty("publisher").GetString()!);
    Console.WriteLine("Package SHA-256 verified; this does not verify publisher signature or installation.");
    return;
}

if (args.SequenceEqual(new[] { "--release-live" }))
{
    using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
        { Timeout = TimeSpan.FromSeconds(30) };
    var token = Environment.GetEnvironmentVariable("GH_TOKEN") ??
        Environment.GetEnvironmentVariable("GITHUB_TOKEN");
    var liveRelease = await new ReleaseUpdates(http).CheckAsync(new Version(0, 1, 0), token);
    Console.WriteLine(JsonSerializer.Serialize(new { liveRelease.State, liveRelease.Package }));
    if (liveRelease.State != "no-release") throw new Exception("Expected visible repository with no release.");
    return;
}

if (args.SequenceEqual(new[] { "--desktop-ipc" }) || args.SequenceEqual(new[] { "--prepared-ipc" }))
{
    var mode = Environment.GetEnvironmentVariable("SWGOH_TEST_WORKER_MODE");
    var log = Environment.GetEnvironmentVariable("SWGOH_TEST_WORKER_LOG")!;
    var attempts = 0;
    string? line;
    while ((line = Console.ReadLine()) != null)
    {
        using var request = JsonDocument.Parse(line);
        var id = request.RootElement.GetProperty("id").GetString();
        var operation = request.RootElement.GetProperty("operation").GetString();
        File.AppendAllText(log, operation + "\n");
        if (mode is "delay" or "close-timeout" && operation == "connect") await Task.Delay(250);
        if (mode == "bad-id") id = "foreign-id";
        if (mode == "cleanup-fails" && operation == "disconnect" && attempts++ == 0)
            Console.WriteLine(JsonSerializer.Serialize(new { id, ok = false, error = "cleanup incomplete" }));
        else Console.WriteLine(JsonSerializer.Serialize(new { id, ok = true, result = new { disconnected = true, protocol = "jsonl-v1" } }));
    }
    Console.WriteLine("{\"event\":\"closed\",\"cleanup\":{\"disconnected\":true}}");
    return;
}

if (args.Length != 1) throw new Exception("Supply an isolated test directory.");
var root = Path.Combine(Path.GetFullPath(args[0]), Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
int passed = 0;
void Check(bool condition, string message) { if (!condition) throw new Exception(message); passed++; }
await ReleaseUpdateTests.Run(Check);
await PackageDownloadTests.Run(root, Check);
MsixIdentityTests.Run(root, Check);
Check(BattlePresentation.FromSnapshot(default) == null, "no snapshot has no fabricated target");
using (var snapshot = JsonDocument.Parse("""
{"inspectedUnit":"second","units":[
 {"sessionKey":"first","baseId":"VADER","unitId":"one","attributes":{"stats":[]}},
 {"sessionKey":"second","baseId":"VADER","unitId":"two","owner":1,"attributes":{
   "health":{"current":50,"max":100},"protection":{"permanent":{"current":0,"max":20}},
   "mastery":{"initial":25,"current":0,"netBattleDelta":-25},
   "stats":[{"id":5,"name":"SPEED","initial":100,"current":90,"netBattleDelta":-10},{"name":"Unknown"}]
 }}]}
"""))
{
    var view = BattlePresentation.FromSnapshot(snapshot.RootElement)!;
    Check(view.UnitId == "two" && view.Side == "敌方", "same hero instances matched by exact session key");
    Check(view.Pools.Contains("50 / 100") && view.Pools.Contains("0 / 20") && view.Pools.Contains("— / —"), "missing pool is not zero");
    Check(view.Mastery.Contains("-25") && view.Rows[0].Delta == "-10", "native deltas preserved without invented attribution");
    Check(view.Rows[1].Current == "—", "missing stat is not zero");
}
void Reject(Action action)
{
    try { action(); } catch (IOException) { passed++; return; }
    throw new Exception("Expected refusal");
}
string Hash(string file) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).ToLowerInvariant();
string Package(string name, string exe = "not executable")
{
    var folder = Path.Combine(root, name);
    Directory.CreateDirectory(folder);
    File.WriteAllText(Path.Combine(folder, CliInstaller.ExeName), exe);
    File.WriteAllText(Path.Combine(folder, CliInstaller.GuideName), "中文说明 --jsonl");
    File.WriteAllText(Path.Combine(folder, "manifest.json"), JsonSerializer.Serialize(new {
        schemaVersion = 1, exeSha256 = Hash(Path.Combine(folder, CliInstaller.ExeName)),
        guideSha256 = Hash(Path.Combine(folder, CliInstaller.GuideName)) }));
    return folder;
}
var source = Package("source");
var destination = Path.Combine(root, "installed");
var installer = new CliInstaller(source, destination);
var package = installer.ReadPackage();
Check(!installer.IsInstalled(package), "not installed initially");
var result = installer.Install();
Check(File.Exists(result) && installer.IsInstalled(package), "installed and verified");
Check(installer.Install() == result, "repeat is idempotent");
Check(installer.ReadGuide().Contains("中文"), "UTF-8 guide");
Check(File.ReadAllText(result) == "not executable", "bytes unchanged, no execution");

var corruptSource = Package("corrupt");
File.AppendAllText(Path.Combine(corruptSource, CliInstaller.ExeName), "bad");
Reject(() => new CliInstaller(corruptSource, destination).Install());
Check(File.ReadAllText(result) == "not executable", "bad source does not modify installation");

File.AppendAllText(result, "tampered");
Reject(() => installer.Install());
Check(File.ReadAllText(result).EndsWith("tampered"), "existing corrupt file never overwritten");
var updateSource = Package("updated", "new version");
var update = new CliInstaller(updateSource, destination);
var updateResult = update.Install();
Check(updateResult != result && File.Exists(result), "new version preserves prior directory");

var traversalSource = Package("traversal");
File.WriteAllText(Path.Combine(traversalSource, "manifest.json"),
    "{\"schemaVersion\":1,\"exeSha256\":\"../outside\",\"guideSha256\":\"invalid\"}");
Reject(() => new CliInstaller(traversalSource, destination).Install());
var missingSource = Package("missing");
File.Delete(Path.Combine(missingSource, CliInstaller.GuideName));
Reject(() => new CliInstaller(missingSource, destination).Install());
var concurrent = new CliInstaller(source, Path.Combine(root, "concurrent"));
var copies = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => Task.Run(concurrent.Install)));
Check(copies.Distinct().Count() == 1 && concurrent.IsInstalled(concurrent.ReadPackage()), "concurrent install converges");
Check(!Directory.EnumerateDirectories(Path.Combine(root, "concurrent"), ".install-*").Any(), "staging cleanup");

RuntimeConnection Fixture(string mode, bool prepared = false)
{
    Environment.SetEnvironmentVariable("SWGOH_TEST_WORKER_MODE", mode);
    Environment.SetEnvironmentVariable("SWGOH_TEST_WORKER_LOG", Path.Combine(root, mode + ".log"));
    try { return RuntimeConnection.Start(Environment.ProcessPath!, prepared); }
    finally
    {
        Environment.SetEnvironmentVariable("SWGOH_TEST_WORKER_MODE", null);
        Environment.SetEnvironmentVariable("SWGOH_TEST_WORKER_LOG", null);
    }
}
var preparedConnection = Fixture("prepared", prepared: true);
try { await preparedConnection.RequestAsync("arm"); throw new Exception("prepared channel accepted real battle control"); }
catch (ArgumentException) { passed++; }
await preparedConnection.RequestAsync("start", new { manifest = "fixture" });
await preparedConnection.RequestAsync("snapshot");
await preparedConnection.RequestAsync("prepare", new { battle = "fixture" });
await preparedConnection.CloseAsync();
Check(File.ReadAllLines(Path.Combine(root,"prepared.log")).SequenceEqual(new[] { "start","snapshot","prepare","disconnect" }), "prepared channel uses same serial cleanup without exposing normal control");
var sequential = Fixture("sequential");
try { await sequential.RequestAsync("prepare"); throw new Exception("normal channel accepted preparation"); }
catch (ArgumentException) { passed++; }
await Task.WhenAll(sequential.RequestAsync("capabilities"), sequential.RequestAsync("snapshot"));
await sequential.CloseAsync();
Check(sequential.IsClosed && File.ReadAllLines(Path.Combine(root, "sequential.log")).Length == 3, "requests serialize and close once");
await sequential.CloseAsync();
Check(File.ReadAllLines(Path.Combine(root, "sequential.log")).Length == 3, "repeated close does not replay");

var delayed = Fixture("delay");
await delayed.RequestAsync("capabilities");
try { await delayed.RequestAsync("connect", timeout: TimeSpan.FromMilliseconds(30)); throw new Exception("timeout expected"); }
catch (TimeoutException) { passed++; }
try { await delayed.RequestAsync("snapshot"); throw new Exception("uncertain request should block"); }
catch (InvalidOperationException) { passed++; }
await delayed.CloseAsync();
Check(File.ReadAllLines(Path.Combine(root, "delay.log")).SequenceEqual(new[] { "capabilities", "connect", "disconnect" }), "late response drains before one cleanup, no replay");

var closeTimeout = Fixture("close-timeout");
await closeTimeout.RequestAsync("capabilities");
try { await closeTimeout.RequestAsync("connect", timeout: TimeSpan.FromMilliseconds(20)); }
catch (TimeoutException) { passed++; }
try { await closeTimeout.CloseAsync(TimeSpan.FromMilliseconds(20)); throw new Exception("close timeout expected"); }
catch (TimeoutException) { passed++; }
await closeTimeout.CloseAsync();
Check(closeTimeout.IsClosed && File.ReadAllLines(Path.Combine(root, "close-timeout.log")).Count(x => x == "disconnect") == 1,
    "repeated wait after close timeout does not send cleanup twice");

var retryCleanup = Fixture("cleanup-fails");
await retryCleanup.RequestAsync("capabilities");
try { await retryCleanup.CloseAsync(); throw new Exception("cleanup failure expected"); }
catch (RemoteCommandException) { passed++; }
Check(!retryCleanup.IsClosed, "failed cleanup retains worker");
await retryCleanup.CloseAsync();
Check(retryCleanup.IsClosed, "explicit cleanup retry succeeds");

var bad = Fixture("bad-id");
try
{
    try { await bad.RequestAsync("capabilities"); throw new Exception("bad ID expected"); }
    catch (IOException) { passed++; }
    try { await bad.RequestAsync("snapshot"); throw new Exception("poisoned stream should block"); }
    catch (InvalidOperationException) { passed++; }
}
finally
{
    // This is our synthetic fixture, never a real runtime worker.
    using var child = Process.GetProcessById(bad.WorkerPid);
    child.Kill(); await child.WaitForExitAsync();
}
var home = EnemyControlState.Read(JsonSerializer.SerializeToElement(new { state = "HomeBaseGameState" }));
Check(home.CanArm(true) && !home.CanArm(false), "home all-mode only");
Check(!EnemyControlState.Read(default).CanArm(true), "unknown scene cannot arm");
Check(!EnemyControlState.Read(JsonSerializer.SerializeToElement(new { state = "BattleGameState" })).CanArm(true), "cannot arm mid-battle");
var allies = new[] { new AlliedTarget("a", "VADER"), new AlliedTarget("b", "VADER") };
var taunt = EnemyPolicy.Build(EnemyStrategy.OneClickTaunt, new[] { "stale" }, allies, true, true, 1);
Check((bool)taunt["oneClickTaunt"] && ((string[])taunt["allowedTargets"]).Length == 0 && (int)taunt["combatType"] == 1, "taunt replaces selection");
var restricted = EnemyPolicy.Build(EnemyStrategy.RestrictedBasic, new[] { "a", "b" }, allies, false, false, 0);
Check(((string[])restricted["allowedTargets"]).Length == 2 && !restricted.ContainsKey("manualUI") && !restricted.ContainsKey("scope"), "configure preserves distinct hero instances and omits arm fields");
foreach (var selected in new[] { Array.Empty<string>(), new[] { "stale" } })
{
    try { EnemyPolicy.Build(EnemyStrategy.RestrictedBasic, selected, allies, true, true, 0); throw new Exception("invalid target accepted"); }
    catch (ArgumentException) { passed++; }
}
foreach (var enabled in new[] { false, true })
{
    var snapshot = JsonSerializer.SerializeToElement(new { arena = new {
        status = new { armed = true, manualUI = false },
        input = new { policy = new { oneClickTaunt = true, enabled, allowedTargets = Array.Empty<string>() } }
    } });
    Check(EnemyPolicy.Matches(snapshot, EnemyStrategy.OneClickTaunt, Array.Empty<string>()), "pending and active taunt policies recognized");
}
var waiting = CapturePresentation.Read(JsonSerializer.SerializeToElement(new { active = true, path = "reserved.pb", capture = (object?)null }));
Check(waiting.Active && !waiting.Saved && waiting.Path == "", "reserved capture path is not a saved file");
var savedCapture = CapturePresentation.Read(JsonSerializer.SerializeToElement(new {
    active = true, capture = new { path = "original.pb", bytes = 100, sha256 = new string('a', 64) },
    modeProvenance = new { battleType = 1, combatType = 0 }
}));
Check(savedCapture.Saved && savedCapture.Mode.Contains("待验收"), "saved capture does not imply mode replay verification");
var failedCapture = CapturePresentation.Read(JsonSerializer.SerializeToElement(new { active = true, errors = new[] { "integrity error" } }));
Check(failedCapture.HasErrors && failedCapture.Detail.Contains("integrity error"), "capture failures remain visible");
Check(!CapturePresentation.Read(default).Saved, "missing capture does not become success");
Check(!CapturePresentation.Read(JsonSerializer.SerializeToElement(new {
    capture = new { path = "bad.pb", bytes = -1, sha256 = new string('a',64) }
})).Saved, "invalid byte count not displayed as saved");
var milkPath = Path.Combine(root, "蓝奶 空格", "Pro.BLUEMILK");
Check(PackageOpenArguments.Parse(["--install-mod", milkPath]).Single() == milkPath, "shell file path keeps Unicode, spaces and extension case");
Check(PackageOpenArguments.Parse([milkPath, milkPath.ToLowerInvariant()]).Length == 1, "duplicate file activation paths collapsed");
Check(PackageOpenArguments.FromCommandLine($"\"D:\\Program Files\\BlueMilk Editor\\BlueMilk.Editor.exe\" --install-mod \"{milkPath}\"").SequenceEqual(new[] { "--install-mod", milkPath }), "redirect parses a quoted executable and package path");
Check(PackageOpenArguments.FromCommandLine($"--install-mod \"{milkPath}\"").SequenceEqual(new[] { "--install-mod", milkPath }), "redirect accepts arguments without executable prefix");
Check(PackageOpenArguments.Parse([]).Length == 0, "plain launch opens without installing a package");
foreach (var invalid in new[] { new[] { "--install-mod" }, new[] { "--install-mod", "relative.bluemilk" }, new[] { "--install-mod", Path.Combine(root,"bad.exe") }, new[] { "--install-mod", milkPath, "--enable" } }) {
    try { PackageOpenArguments.Parse(invalid); throw new Exception("invalid package activation accepted"); }
    catch (ArgumentException) { passed++; }
}
Console.WriteLine(JsonSerializer.Serialize(new { passed, root }));
