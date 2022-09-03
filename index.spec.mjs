import { describe, expect, it } from 'vitest'
import wwutil, { Window } from './index.mjs'

describe('wwutil', () => {
  it('getAllWindowHwnds', async () => {
    const hwnds = await wwutil.getAllWindowHwnds()
    expect(hwnds).toBeInstanceOf(Array)
    expect(hwnds[0]).toBeTypeOf('number')
  })
  it('getActiveWindowHwnd', async () => {
    expect(await wwutil.getActiveWindowHwnd()).toBeTypeOf('number')
  })
  it('getIsVisibleByHwnd', async () => {
    const hwnds = await wwutil.getAllWindowHwnds()
    const visibles = await Promise.all(hwnds.map(wwutil.getIsVisibleByHwnd))
    expect(visibles).toContain(true)
    expect(visibles).toContain(false)
  })
  it('getTitleByHwnd', async () => {
    expect(
      await wwutil.getActiveWindowHwnd().then(wwutil.getTitleByHwnd)
    ).toBeTypeOf('string')
  })
  it('getPidByHwnd', async () => {
    expect(
      await wwutil.getActiveWindowHwnd().then(wwutil.getPidByHwnd)
    ).toBeTypeOf('number')
  })

  const windowMembers = Object.keys(new Window())
  const windowTest = (window, definedMembers = []) => {
    for (const member of definedMembers) {
      expect(window[member]).toBeDefined()
    }
  }

  it('fillWindowFields', async () => {
    const hwnd = await wwutil.getActiveWindowHwnd()
    const window = new Window(hwnd)
    windowTest(window, ['hwnd'])
    await wwutil.fillWindowFields(window, ['title'])
    windowTest(window, ['hwnd', 'title'])
    await wwutil.fillWindowFields(window, ['path'])
    windowTest(window, ['hwnd', 'title', 'pid', 'path'])
    await wwutil.fillWindowFields(window, ['visible'])
    windowTest(window, windowMembers)
  })
  it('getWindowByHwnd', async () => {
    const hwnd = await wwutil.getActiveWindowHwnd()
    windowTest(await wwutil.getWindowByHwnd(hwnd, []), ['hwnd'])
    windowTest(await wwutil.getWindowByHwnd(hwnd, ['title']), ['hwnd', 'title'])
    windowTest(await wwutil.getWindowByHwnd(hwnd, ['path']), [
      'hwnd',
      'pid',
      'path',
    ])
    windowTest(await wwutil.getWindowByHwnd(hwnd, ['visible']), [
      'hwnd',
      'visible',
    ])
    windowTest(await wwutil.getWindowByHwnd(hwnd), windowMembers)
  })
  it('getActiveWindow', async () => {
    windowTest(await wwutil.getActiveWindow([]), ['hwnd'])
    windowTest(await wwutil.getActiveWindow(['title']), ['hwnd', 'title'])
    windowTest(await wwutil.getActiveWindow(['path']), ['hwnd', 'pid', 'path'])
    windowTest(await wwutil.getActiveWindow(['visible']), ['hwnd', 'visible'])
    windowTest(await wwutil.getActiveWindow(), windowMembers)
  })
  it('getAllWindows', async () => {
    const allWindows = await wwutil.getAllWindows(true, [])
    const partWindows = await wwutil.getAllWindows(false, [])
    expect(partWindows.length).toBeLessThanOrEqual(allWindows.length)
  })
  it('getDriveMap', async () => {
    const driveMap = await wwutil.getDriveMap()
    expect(driveMap['C']).toBeTypeOf('string')
  })
  it('getPathByPid', async () => {
    const hwnd = await wwutil.getActiveWindowHwnd()
    const pid = await wwutil.getPidByHwnd(hwnd)
    const path = await wwutil.getPathByPid(pid)
    expect(path).toBeTypeOf('string')
  })
})
