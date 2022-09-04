const util = require('node:util')
const ffi = require('ffi-napi')
const ref = require('ref-napi')
const wcharT = require('ref-wchar-napi')

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
class Window {
  constructor(...args) {
    windowMembers.forEach((member, i) => (this[member] = args[i]))
  }
}

const strArg = (string) => Buffer.from(string + '\0', 'ucs2')

const getW = async (func, splitZeros = false, len = 256) => {
  while (true) {
    // TODO: len が足りない時に catch へ行かず落ちることがある。要修正
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

/**
 * 全てのウィンドウの hwnd を取得する
 * @return {Array<Number>}
 */
wwutil.getAllWindowHwnds = async () => {
  const hwnds = []

  const callback = ffi.Callback('bool', ['long', 'long'], (hwnd, lParam) => {
    hwnds.push(hwnd)
    return true
  })
  await user32.EnumWindows(callback, 0)
  return hwnds
}

/**
 * アクティブなウィンドウの hwnd を取得する
 * @return {Number}
 */
wwutil.getActiveWindowHwnd = async () => {
  return await user32.GetForegroundWindow()
}

/**
 * 指定された hwnd のウィンドウが可視かどうかを取得する
 * @return {Boolean}
 */
wwutil.getIsVisibleByHwnd = async (hwnd) => {
  return await user32.IsWindowVisible(hwnd)
}

/**
 * 指定された hwnd のウィンドウのタイトルを取得する
 * @param {Number} hwnd
 * @return {String}
 */
wwutil.getTitleByHwnd = async (hwnd) => {
  return await getW(
    (buf, len) => user32.GetWindowTextW(hwnd, buf, len),
    false,
    25565
  )
}

/**
 * 指定された hwnd のウィンドウのプロセス ID を取得する
 * @param {Number} hwnd
 * @return {Number}
 */
wwutil.getPidByHwnd = async (hwnd) => {
  const pid = ref.alloc(lpdwordPtr)
  await user32.GetWindowThreadProcessId(hwnd, pid)
  return pid.readInt32LE(0)
}

/**
 * 渡されたウィンドウのフィールドのうち fields に含まれるものについて情報を取得して値を埋め込む
 * @param {Window} window - 対象のウィンドウ
 * @param {Array<String>} fields - 情報を取得する対象のフィールド名を要素にもつ配列 (ex. `['title', 'pid', 'path']`)
 * @param {Object} driveMap - ドライブレターがキー、デバイス名が値のオブジェクト。複数回このメソッドを呼ぶときに外側で driveMap を作って渡すとドライブについての情報を重複して取得せずに済む
 * @param {Object} processMap - プロセスID がキー、プロセスの実行ファイルパスが価のオブジェクト。driveMap と用途は同様
 * @return {undefined} 引数の window に値を入れるだけなので返り値は無し
 */
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

/**
 * 指定された hwnd のウィンドウに関する情報を取得する
 * @param {Number} hwnd - 取得したいウィンドウの hwnd
 * @param {Array<String>} requireFields - fillWindowFields の fields と同様
 * @param {Object} driveMap - fillWindowFields と同様
 * @param {Object} processMap - fillWindowFields と同様
 * @return {Window}
 */
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

/**
 * アクティブなウィンドウに関する情報を取得する
 * @param {Array<String>} requireFields - fillWindowFields の fields と同様
 * @param {Object} driveMap - fillWindowFields と同様
 * @param {Object} processMap - fillWindowFields と同様
 * @return {Window}
 */
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

/**
 * 全てのウィンドウに関する情報を配列で取得する
 * @param {Boolean} all - true の場合は全てのウィンドウを、false の場合は可視かつタイトルが存在するウィンドウのみを取得する
 * @param {Array<String>} requireFields - fillWindowFields の fields と同様
 * @return {Array<Window>}
 */
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

/**
 * ドライブレターをキー、デバイス名を値とするオブジェクトを取得する
 * @return {Object}
 */
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

/**
 * 指定したプロセス ID の実行ファイルのパスを取得する
 * @param {Number} pid - 対象のプロセス ID
 * @param {Object} driveMap - fillWindowFields と同様
 * @param {Object} processMap - fillWindowFields と同様
 * @return {String}
 */
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

module.exports = {
  ...wwutil,
  Window,
}
