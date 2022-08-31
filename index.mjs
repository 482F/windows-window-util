import util from 'node:util'
import ffi from 'ffi-napi'
import ref from 'ref-napi'
import wcharT from 'ref-wchar-napi'

const voidPtr = ref.refType(ref.types.void)
const lpdwordPtr = ref.refType(ref.types.ulong)

const dllPromise = (name, definitions) =>
  Object.fromEntries(
    Object.entries(ffi.Library(name, definitions)).map(([name, func]) => [
      name,
      util.promisify(func.async),
    ])
  )

const user32 = dllPromise('user32', {
  EnumWindows: ['bool', [voidPtr, 'long']],
  GetForegroundWindow: ['long', []],
  IsWindowVisible: ['bool', ['long']],
  GetWindowTextW: ['long', ['long', wcharT.string, 'long']],
  GetWindowThreadProcessId: ['long', ['long', lpdwordPtr]],
})

const kernel32 = dllPromise('kernel32', {
  OpenProcess: ['long', ['long', 'bool', 'long']],
  CloseHandle: ['long', ['long']],
  GetLogicalDriveStringsW: ['long', ['long', wcharT.string]],
  QueryDosDeviceW: ['long', ['string', wcharT.string, 'long']],
})

const psapi = dllPromise('Psapi', {
  GetProcessImageFileNameW: ['long', ['long', wcharT.string, 'long']],
})

const windowMembers = ['hwnd', 'title', 'pid', 'path', 'visible']
export class Window {
  constructor(...args) {
    windowMembers.forEach((member, i) => (this[member] = args[i]))
  }
}

const strArg = (string) => Buffer.from(string + '\0', 'ucs2')

const getW = async (func, splitZeros = false) => {
  let len = 256
  while (true) {
    try {
      const buf = Buffer.alloc(len)
      await func(buf, len)
      if (!splitZeros) {
        return wcharT.toString(ref.reinterpretUntilZeros(buf, wcharT.size))
      }
      let result = true
      let offset = 0
      const results = []
      while (result) {
        result = wcharT.toString(
          ref.reinterpretUntilZeros(buf, wcharT.size, offset)
        )
        results.push(result)
        offset += (Buffer.byteLength(result) + 1) * 2
      }
      return results.slice(0, -1)
    } catch (e) {
      if (e.message !== '"length" is outside of buffer bounds') {
        throw e
      }
      len *= 2
    }
  }
}

const wwutil = {}

wwutil.getAllWindowHwnds = async () => {
  const hwnds = []

  const callback = ffi.Callback('bool', ['long', 'long'], (hwnd, lParam) => {
    hwnds.push(hwnd)
    return true
  })
  await user32.EnumWindows(callback, 0)
  return hwnds
}

wwutil.getActiveWindowHwnd = async () => {
  return await user32.GetForegroundWindow()
}

wwutil.getIsVisibleByHwnd = async (hwnd) => {
  return await user32.IsWindowVisible(hwnd)
}

wwutil.getTitleByHwnd = async (hwnd) => {
  return await getW((buf, len) => user32.GetWindowTextW(hwnd, buf, len))
}

wwutil.getPidByHwnd = async (hwnd) => {
  const pid = ref.alloc(lpdwordPtr)
  await user32.GetWindowThreadProcessId(hwnd, pid)
  return pid.readInt32LE(0)
}

wwutil.fillWindowFields = async (
  window,
  fields,
  driveMap = undefined,
  processMap = undefined
) => {
  fields ??= [...windowMembers]
  const defs = {
    hwnd: () => window.hwnd,
    title: () => wwutil.getTitleByHwnd(window.hwnd),
    pid: () => wwutil.getPidByHwnd(window.hwnd),
    path: async (values) => {
      values.pid ??= defs.pid()
      const pid = await values.pid
      return wwutil.getPathByPid(pid, driveMap, processMap)
    },
    visible: () => wwutil.getIsVisibleByHwnd(window.hwnd),
  }

  const values = {}
  for (const member of windowMembers) {
    if (!fields.includes(member) || window[member]) {
      continue
    }
    values[member] = defs[member](values)
  }

  for (const [member, value] of Object.entries(values)) {
    window[member] = await value
  }
}

wwutil.getWindowByHwnd = async (
  hwnd,
  requireFields = undefined,
  driveMap = undefined,
  processMap = undefined
) => {
  const window = new Window(hwnd)
  await wwutil.fillWindowFields(window, requireFields, driveMap, processMap)
  return window
}

wwutil.getActiveWindow = async (
  requireFields = undefined,
  driveMap = undefined,
  processMap = undefined
) => {
  return await wwutil.getWindowByHwnd(
    await wwutil.getActiveWindowHwnd(),
    requireFields,
    driveMap,
    processMap
  )
}

wwutil.getAllWindows = async (all = false, requireFields) => {
  const firstFields = (() => {
    if (all) {
      return requireFields
    } else {
      return ['title', 'visible']
    }
  })()
  const driveMap = await wwutil.getDriveMap()
  const processMap = {}
  const windows = await wwutil
    .getAllWindowHwnds()
    .then((hwnds) =>
      hwnds.map((hwnd) =>
        wwutil.getWindowByHwnd(hwnd, firstFields, driveMap, processMap)
      )
    )
    .then((promise) => Promise.all(promise))
  const filteredWindows = all
    ? windows
    : windows.filter((window) => window.visible && window.title)
  await Promise.all(
    filteredWindows.map(async (window) =>
      wwutil.fillWindowFields(window, requireFields, driveMap, processMap)
    )
  )
  return filteredWindows
}

wwutil.getDriveMap = async () => {
  const driveLetters = await getW(
    (buf, len) => kernel32.GetLogicalDriveStringsW(len, buf),
    true
  )
  return Promise.all(
    driveLetters
      .map((dl) => dl[0])
      .map(async (dl) => [
        dl,
        await getW((buf, len) =>
          kernel32.QueryDosDeviceW(strArg(dl + ':'), buf, len)
        ),
      ])
  ).then((result) => Object.fromEntries(result))
}

wwutil.getPathByPid = async (pid, driveMap = undefined, processMap = {}) => {
  processMap[pid] ??= (async () => {
    driveMap ??= await wwutil.getDriveMap()
    const process = await kernel32.OpenProcess(0x1000, false, pid)
    try {
      const rawPath = await getW((buf, len) =>
        psapi.GetProcessImageFileNameW(process, buf, len)
      )
      for (const [driveLetter, deviceName] of Object.entries(driveMap)) {
        if (rawPath.indexOf(deviceName) === 0) {
          return rawPath.replace(deviceName, driveLetter + ':')
        }
      }
    } finally {
      await kernel32.CloseHandle(process)
    }
  })()

  return await processMap[pid]
}

export default wwutil
