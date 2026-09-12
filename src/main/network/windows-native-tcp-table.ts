/** Fixed read-only native table code, embedded in the readers' existing Add-Type.
 * Layouts: MIB_TCPROW_OWNER_PID (24 bytes), MIB_TCP6ROW_OWNER_PID (56 bytes).
 * https://learn.microsoft.com/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable
 * Only the compiled type can be reused by a worker; every call rereads both families.
 */
export const WINDOWS_NATIVE_TCP_TABLE_CSHARP = String.raw`
public sealed class ClipdockNativeTcpRow {
  public uint OwningProcess;
  public string LocalAddress;
  public int LocalPort;
  public string RemoteAddress;
  public int RemotePort;
  public string State;
}
public static class ClipdockNativeTcpTable {
  private const int AF_INET = 2, AF_INET6 = 23, OWNER_PID_ALL = 5;
  private const uint INSUFFICIENT_BUFFER = 122, MAX_TABLE_BYTES = 16 * 1024 * 1024;
  [DllImport("iphlpapi.dll", SetLastError=false)]
  private static extern uint GetExtendedTcpTable(IntPtr table, ref uint size,
    [MarshalAs(UnmanagedType.Bool)] bool sorted, int family, int tableClass, uint reserved);

  private static int Port(IntPtr row, int offset) {
    // The first two bytes of each port DWORD are in network byte order.
    return (Marshal.ReadByte(row, offset) << 8) | Marshal.ReadByte(row, offset + 1);
  }
  private static uint NetworkUInt(IntPtr row, int offset) {
    return ((uint)Marshal.ReadByte(row, offset) << 24) |
      ((uint)Marshal.ReadByte(row, offset + 1) << 16) |
      ((uint)Marshal.ReadByte(row, offset + 2) << 8) | Marshal.ReadByte(row, offset + 3);
  }
  private static string Address(IntPtr row, int offset, int family, int scopeOffset) {
    var bytes = new byte[family == AF_INET ? 4 : 16];
    Marshal.Copy(IntPtr.Add(row, offset), bytes, 0, bytes.Length);
    return family == AF_INET ? new System.Net.IPAddress(bytes).ToString() :
      new System.Net.IPAddress(bytes, NetworkUInt(row, scopeOffset)).ToString();
  }
  private static string State(uint state) {
    switch (state) {
      case 1: return "Closed";
      case 2: return "Listen";
      case 3: return "SynSent";
      case 4: return "SynReceived";
      case 5: return "Established";
      case 6: return "FinWait1";
      case 7: return "FinWait2";
      case 8: return "CloseWait";
      case 9: return "Closing";
      case 10: return "LastAck";
      case 11: return "TimeWait";
      case 12: return "DeleteTCB";
      default: throw new InvalidOperationException("TCP_TABLE_STATE_UNAVAILABLE");
    }
  }
  private static void ReadFamily(int family, int localPort,
    System.Collections.Generic.HashSet<uint> ownerPids,
    System.Collections.Generic.List<ClipdockNativeTcpRow> rows) {
    uint required = 0;
    uint result = GetExtendedTcpTable(IntPtr.Zero, ref required, false, family, OWNER_PID_ALL, 0);
    if (result != INSUFFICIENT_BUFFER) throw new InvalidOperationException("TCP_TABLE_UNAVAILABLE");
    for (int attempt = 0; attempt < 3; attempt++) {
      if (required < 4 || required > MAX_TABLE_BYTES) throw new InvalidOperationException("TCP_TABLE_UNAVAILABLE");
      uint capacity = required;
      IntPtr table = Marshal.AllocHGlobal(checked((int)capacity));
      try {
        result = GetExtendedTcpTable(table, ref required, false, family, OWNER_PID_ALL, 0);
        if (result == INSUFFICIENT_BUFFER) continue;
        if (result != 0 || required < 4 || required > capacity)
          throw new InvalidOperationException("TCP_TABLE_UNAVAILABLE");
        int rowSize = family == AF_INET ? 24 : 56;
        uint count = unchecked((uint)Marshal.ReadInt32(table));
        if (count > (required - 4) / rowSize) throw new InvalidOperationException("TCP_TABLE_UNAVAILABLE");
        for (uint index = 0; index < count; index++) {
          IntPtr row = IntPtr.Add(table, checked(4 + (int)index * rowSize));
          uint pid = unchecked((uint)Marshal.ReadInt32(row, family == AF_INET ? 20 : 52));
          uint state = unchecked((uint)Marshal.ReadInt32(row, family == AF_INET ? 0 : 48));
          int sourcePort = Port(row, family == AF_INET ? 8 : 20);
          if (ownerPids != null && !ownerPids.Contains(pid)) continue;
          if (localPort != 0 && (state != 2 || sourcePort != localPort)) continue;
          rows.Add(new ClipdockNativeTcpRow {
            OwningProcess = pid,
            LocalAddress = Address(row, family == AF_INET ? 4 : 0, family, 16),
            LocalPort = sourcePort,
            RemoteAddress = Address(row, family == AF_INET ? 12 : 24, family, 40),
            RemotePort = Port(row, family == AF_INET ? 16 : 44),
            State = State(state)
          });
        }
        return;
      } finally { Marshal.FreeHGlobal(table); }
    }
    throw new InvalidOperationException("TCP_TABLE_UNAVAILABLE");
  }
  private static ClipdockNativeTcpRow[] Read(int localPort, System.Collections.Generic.HashSet<uint> ownerPids) {
    var rows = new System.Collections.Generic.List<ClipdockNativeTcpRow>();
    ReadFamily(AF_INET, localPort, ownerPids, rows);
    ReadFamily(AF_INET6, localPort, ownerPids, rows);
    return rows.ToArray();
  }
  public static ClipdockNativeTcpRow[] ReadListeners(int localPort) {
    if (localPort < 1 || localPort > 65535) throw new InvalidOperationException("TCP_TABLE_SCOPE_INVALID");
    return Read(localPort, null);
  }
  public static ClipdockNativeTcpRow[] ReadForOwners(uint[] ownerPids) {
    if (ownerPids == null || ownerPids.Length < 1 || ownerPids.Length > 32)
      throw new InvalidOperationException("TCP_TABLE_SCOPE_INVALID");
    return Read(0, new System.Collections.Generic.HashSet<uint>(ownerPids));
  }
}
`;
