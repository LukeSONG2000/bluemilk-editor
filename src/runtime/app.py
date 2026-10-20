"""Self-contained SWGoH information and arena controller desktop entry point."""
import argparse
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import sys
import threading
import time
import tkinter as tk
from tkinter import ttk

import frida
import psutil
from session_lock import acquire_session
from inbox_claims import InboxClaims

from runtime_core import ASSETS, DATA, EXPECTED, MODULES, Runtime, find_game

LABELS = {1:'最大生命',2:'力量',3:'敏捷',4:'智力',5:'速度',6:'物理伤害',7:'特殊伤害',8:'护甲',9:'抗性',10:'护甲穿透',11:'抗性穿透',12:'闪避等级',13:'偏转等级',14:'物理暴击等级',15:'特殊暴击等级',16:'暴击伤害',18:'效能',19:'韧性',24:'吸血',25:'最大护盾',61:'精通'}

def number(value):
    return '—' if value is None else f'{value:,.3f}'.rstrip('0').rstrip('.')

def pool(value):
    return f"{number(value.get('current'))} / {number(value.get('max'))}"


def signed_number(value):
    if value is None or not math.isfinite(value):
        return '—'
    return number(value) if value == 0 else f'{value:+,.3f}'.rstrip('0').rstrip('.')


def attribute_summary(attributes):
    protection=attributes['protection'];mastery=attributes.get('mastery',{})
    lines=['生命 '+pool(attributes['health']),
           '护盾 '+pool(protection['permanent'])+'    临时护盾 '+pool(protection['bonus']),
           '精通 '+number(mastery.get('initial'))+' → '+number(mastery.get('current'))+
           '（净变化 '+signed_number(mastery.get('netBattleDelta'))+'）']
    if mastery.get('beforeLimits') is not None:
        lines.append('限制前精通 '+number(mastery['beforeLimits'])+
                     '（相对初始 '+signed_number(mastery.get('netBeforeLimits'))+'）')
        if mastery.get('limitAdjustment') not in (None,0):
            lines.append('上下限调整 '+signed_number(mastery['limitAdjustment'])+'，已计入当前值')
    return '\n'.join(lines)

class Window:
    def __init__(self, smoke=False):
        self.root = tk.Tk()
        self.root.title('SWGoH · 信息拓展与战斗控制')
        self.root.geometry('660x850+80+60')
        self.root.minsize(600,720)
        self.runtime = Runtime()
        self.requests, self.responses = queue.Queue(), queue.Queue()
        self.connected = self.busy = self.closing = self.polling = False
        self.snapshot = {}
        self.poll_error = False
        self.target_vars = {}
        self.target_ids = []
        self.names = json.loads((ASSETS/'names.json').read_text(encoding='utf-8'))
        threading.Thread(target=self.worker, daemon=True).start()
        s=ttk.Style(self.root);s.theme_use('clam')
        s.configure('TFrame',background='#142435');s.configure('TLabel',background='#142435',foreground='#e2edf8',font=('Microsoft YaHei UI',10))
        s.configure('TCheckbutton',background='#142435',foreground='#e2edf8',font=('Microsoft YaHei UI',10))
        s.map('TCheckbutton',background=[('active','#203b54')])
        s.configure('TButton',font=('Microsoft YaHei UI',10),padding=6)
        frame=ttk.Frame(self.root,padding=16);frame.pack(fill='both',expand=True)
        ttk.Label(frame,text='信息拓展与战斗控制',font=('Microsoft YaHei UI',19,'bold')).pack(anchor='w')
        ttk.Label(frame,text='原客户端运行中即可连接 · 每场战斗单独启用控制').pack(anchor='w',pady=(3,12))
        top=ttk.Frame(frame);top.pack(fill='x')
        self.connect_button=ttk.Button(top,text='连接游戏',command=self.connect);self.connect_button.pack(side='left')
        self.disconnect_button=ttk.Button(top,text='断开并恢复',command=lambda:self.submit('disconnect'),state='disabled');self.disconnect_button.pack(side='left',padx=8)
        self.topmost=tk.BooleanVar(value=False)
        ttk.Checkbutton(top,text='窗口置顶',variable=self.topmost,command=lambda:self.root.attributes('-topmost',self.topmost.get())).pack(side='right')
        self.info=tk.BooleanVar(value=True)
        self.info_check=ttk.Checkbutton(frame,text='连接时启用游戏内信息拓展',variable=self.info);self.info_check.pack(anchor='w',pady=(10,4))
        ttk.Label(frame,text='小队：血盾数字、技能 CD、有限状态回合数\n舰队：血盾数字、状态回合、属性目标跟随已验证',foreground='#adbed0').pack(anchor='w')
        self.connection=ttk.Label(frame,text='未连接',foreground='#79d4ff');self.connection.pack(anchor='w',pady=8)
        self.feedback=ttk.Label(frame,text='请先登录游戏，再点击连接。',wraplength=600);self.feedback.pack(fill='x',pady=(0,8))
        tabs=ttk.Notebook(frame);tabs.pack(fill='both',expand=True)
        attrs=ttk.Frame(tabs,padding=12);controls=ttk.Frame(tabs,padding=12)
        tabs.add(attrs,text='  实时属性  ');tabs.add(controls,text='  敌方控制  ')
        self.unit=ttk.Label(attrs,text='等待游戏内选中目标',font=('Microsoft YaHei UI',14,'bold'));self.unit.pack(anchor='w')
        self.health=ttk.Label(attrs,text='',wraplength=570);self.health.pack(anchor='w',pady=8)
        self.table=ttk.Treeview(attrs,columns=('name','initial','current','delta'),show='headings')
        for c,title,width in [('name','属性',135),('initial','初始',120),('current','当前',120),('delta','净变化',115)]:
            self.table.heading(c,text=title);self.table.column(c,width=width,anchor='w' if c=='name' else 'e')
        scroll=ttk.Scrollbar(attrs,command=self.table.yview);self.table.configure(yscrollcommand=scroll.set)
        scroll.pack(side='right',fill='y');self.table.pack(fill='both',expand=True)
        ttk.Label(attrs,text='跟随游戏目标／长按信息栏；净变化包含全部战斗因素。',wraplength=570).pack(anchor='w',pady=8)
        self.taunt=tk.BooleanVar(value=True);self.basic=tk.BooleanVar(value=False)
        self.quick=ttk.Checkbutton(controls,text='一键嘲讽',variable=self.taunt,command=self.sync_controls);self.quick.pack(anchor='w')
        ttk.Label(controls,text='覆盖下方配置：仅普攻，随机攻击原版合法目标中的我方肉盾。\n没有合法肉盾时等待；被动、协攻、反击仍遵循原规则。',wraplength=570).pack(anchor='w',pady=(4,12))
        self.manual_ui=tk.BooleanVar(value=False)
        self.manual_check=ttk.Checkbutton(controls,text='手动操作敌方（原技能栏、目标及增援选择器）',variable=self.manual_ui,command=self.select_manual)
        self.manual_check.pack(anchor='w',pady=(0,8))
        self.basic_check=ttk.Checkbutton(controls,text='仅普攻 + 下方允许目标',variable=self.basic);self.basic_check.pack(anchor='w')
        ttk.Label(controls,text='允许主动攻击的我方单位（多选）').pack(anchor='w',pady=8)
        self.targets=ttk.Frame(controls);self.targets.pack(fill='x')
        self.all_modes=tk.BooleanVar(value=False)
        self.mode_check=ttk.Checkbutton(controls,text='下一场使用全模式入口（其他模式待逐项实测）',variable=self.all_modes,command=self.sync_controls)
        self.mode_check.pack(anchor='w',pady=(8,2))
        self.combat_type=tk.StringVar(value='小队')
        self.combat_picker=ttk.Combobox(controls,textvariable=self.combat_type,values=('小队','舰队'),state='readonly',width=12)
        self.combat_picker.pack(anchor='w',pady=(0,6))
        self.empty=ttk.Label(controls,text='进入竞技场阵容页或战斗后显示单位。');self.empty.pack(anchor='w')
        buttons=ttk.Frame(controls);buttons.pack(fill='x',pady=14)
        self.arm=ttk.Button(buttons,text='启用本场控制',command=lambda:self.policy('arm'));self.arm.pack(side='left')
        self.apply=ttk.Button(buttons,text='应用配置',command=lambda:self.policy('configure'));self.apply.pack(side='left',padx=8)
        self.cancel=ttk.Button(buttons,text='解除控制',command=lambda:self.submit('disarm'));self.cancel.pack(side='left')
        self.control_state=ttk.Label(controls,text='未启用',wraplength=570);self.control_state.pack(anchor='w')
        ttk.Label(controls,text='默认在竞技场阵容页启用。全模式入口可在战斗外启用，先选择小队／舰队，再自行进入战斗。\n仅作用于下一场，结束自动解除。自动与倍速使用原按钮。',wraplength=570).pack(anchor='w',pady=12)
        self.root.protocol('WM_DELETE_WINDOW',self.close)
        self.root.after(150,self.refresh);self.sync_controls()
        if smoke:self.root.after(18000,self.close)

    def worker(self):
        while True:
            op,payload=self.requests.get()
            try:
                if op=='connect':result=self.runtime.connect(payload)
                elif op=='disconnect':result=self.runtime.disconnect()
                else:result=self.runtime.call(op,payload)
                self.responses.put((op,result,None))
            except Exception as e:
                DATA.mkdir(parents=True,exist_ok=True)
                with (DATA/'desktop-errors.log').open('a',encoding='utf-8') as f:f.write(f'{time.time()} {op}: {e}\n')
                self.responses.put((op,None,str(e).split('\n')[0]))

    def submit(self,op,payload=None):
        if self.busy:return
        if op=='inspect':self.polling=True
        else:self.busy=True
        self.requests.put((op,payload));self.sync_controls()

    def connect(self):self.submit('connect',self.info.get())

    def select_manual(self):
        if self.manual_ui.get():
            self.taunt.set(False);self.basic.set(False)
        self.sync_controls()

    def policy(self,op):
        chosen=[uid for uid,v in self.target_vars.items() if v.get()]
        manual=self.manual_ui.get()
        if not manual and self.basic.get() and not self.taunt.get() and not chosen:
            self.feedback.config(text='请至少选择一个允许攻击的单位。');return
        payload={'enabled':False if manual else self.basic.get(),'oneClickTaunt':False if manual else self.taunt.get(),'allowedTargets':[] if manual else chosen}
        if op=='arm':payload['manualUI']=manual
        if op=='arm' and self.all_modes.get():
            payload.update(scope='all',combatType={'小队':0,'舰队':1}[self.combat_type.get()])
        self.submit(op,payload)

    def sync_controls(self):
        ready=self.connected and not self.busy
        self.connect_button.config(state='disabled' if self.connected or self.busy else 'normal')
        self.disconnect_button.config(state='normal' if ready else 'disabled')
        self.info_check.config(state='disabled' if self.connected or self.busy else 'normal')
        arena=self.snapshot.get('arena') or {};armed=arena.get('status',{}).get('armed',False)
        state=self.snapshot.get('state')
        can_arm=bool(state and state!='BattleGameState') if self.all_modes.get() else state=='PvpPreBattleState' and self.snapshot.get('arenaReady')
        self.arm.config(state='normal' if ready and not armed and can_arm else 'disabled')
        self.mode_check.config(state='disabled' if armed or self.busy else 'normal')
        self.manual_check.config(state='disabled' if armed or self.busy else 'normal')
        self.quick.config(state='disabled' if self.manual_ui.get() else 'normal')
        self.combat_picker.config(state='readonly' if self.all_modes.get() and not armed and not self.busy else 'disabled')
        for button in [self.apply,self.cancel]:button.config(state='normal' if ready and armed else 'disabled')
        locked=self.taunt.get() or self.manual_ui.get()
        self.basic_check.config(state='disabled' if locked else 'normal')
        for widget in self.targets.winfo_children():widget.config(state='disabled' if locked else 'normal')

    def render(self,d):
        self.snapshot=d
        arena=d.get('arena') or {};status=arena.get('status',{});policy=arena.get('input',{}).get('policy',{})
        state={'HomeBaseGameState':'酒馆','MatchMakingState':'竞技场列表','ShipMatchmakingGameState':'舰队竞技场列表','CharacterMatchmakingGameState':'小队竞技场列表','PvpPreBattleState':'竞技场阵容选择','BattleGameState':'战斗中'}.get(d.get('state'),d.get('state','读取中'))
        self.connection.config(text='已连接 · '+state)
        title={0:'小队',1:'舰队'}.get(status.get('combatType'),'')
        self.control_state.config(text=policy.get('blocked') or ('已结束，下一场需重新启用' if status.get('finished') else title+'本场控制已启用' if status.get('armed') else '未启用'))
        units=d.get('units',[])
        allies=d.get('roster') or [u for u in units if u.get('owner')==0]
        ids=[u['unitId'] for u in allies]
        if ids!=self.target_ids:
            selected={uid:v.get() for uid,v in self.target_vars.items()}
            for widget in self.targets.winfo_children():widget.destroy()
            self.target_ids=ids;self.target_vars={}
            for i,u in enumerate(allies):
                v=tk.BooleanVar(value=selected.get(u['unitId'],False));self.target_vars[u['unitId']]=v
                ttk.Checkbutton(self.targets,text=self.names.get(u['baseId'],u['baseId']),variable=v).grid(row=i//2,column=i%2,sticky='w',padx=3,pady=3)
        self.empty.config(text='' if ids else '进入竞技场阵容页或战斗后显示单位。')
        unit=next((u for u in units if u['sessionKey']==d.get('inspectedUnit')),None)
        self.table.delete(*self.table.get_children())
        if unit:
            self.unit.config(text=('我方 · ' if unit.get('owner')==0 else '敌方 · ')+self.names.get(unit['baseId'],unit['baseId']))
            a=unit['attributes']
            self.health.config(text=attribute_summary(a))
            for stat in a['stats']:self.table.insert('','end',values=(LABELS.get(stat['id'],stat['name']),number(stat.get('initial')),number(stat.get('current')),signed_number(stat.get('netBattleDelta'))))
        else:self.unit.config(text='等待游戏内选中目标');self.health.config(text='')

    def refresh(self):
        while not self.responses.empty():
            op,result,error=self.responses.get()
            if op=='inspect':self.polling=False
            else:self.busy=False
            if error:
                self.poll_error=op=='inspect'
                self.feedback.config(text=('读取暂未成功，正在重试：' if self.poll_error else '')+error)
                self.closing=False
            elif op=='connect':
                self.connected=True;self.render(result['snapshot']);self.feedback.config(text='连接成功；可切换到敌方控制页启用本场。')
            elif op=='inspect':
                self.render(result)
                if self.poll_error:self.feedback.config(text='已恢复正常读取。');self.poll_error=False
            elif op=='disconnect':
                self.connected=False;self.render({});self.connection.config(text='已断开，原行为已恢复');self.feedback.config(text='可再次连接。')
                if self.closing:self.root.destroy();return
            else:self.feedback.config(text='配置已确认。')
        self.sync_controls()
        if self.closing and not self.busy:
            if self.connected:self.submit('disconnect')
            else:self.root.destroy();return
        elif self.connected and not self.busy and not self.polling:self.submit('inspect')
        self.root.after(900,self.refresh)

    def close(self):
        self.closing=True
        if not self.connected and not self.busy:self.root.destroy()
        else:self.feedback.config(text='正在解除控制并断开，请稍候…')

def main():
    parser=argparse.ArgumentParser()
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument('--self-test');mode.add_argument('--probe');mode.add_argument('--ui-smoke',action='store_true');mode.add_argument('--jsonl',action='store_true')
    mode.add_argument('--app-server', action='store_true', help='Run the persistent shared service')
    mode.add_argument('--mastery-compare',nargs=2,metavar=('BEFORE','AFTER'),help='Compare two saved native observations offline')
    parser.add_argument('--unit-id',help='Exact unit instance for --mastery-compare')
    parser.add_argument('--server',help='Use auto for discovery, or ws://127.0.0.1:PORT/rpc with BLUEMILK_SERVER_TOKEN')
    args=parser.parse_args()
    if args.server and not args.jsonl:
        parser.error('--server requires --jsonl')
    if bool(args.mastery_compare)!=bool(args.unit_id):
        parser.error('--mastery-compare and --unit-id must be supplied together')
    if args.app_server:
        import asyncio
        from app_server import run_host
        if sys.stdout is None:
            raise RuntimeError('Use bluemilk.exe for the shared service')
        sys.stdout.reconfigure(encoding='utf-8')
        asyncio.run(run_host(Runtime(), os.environ.get('BLUEMILK_SERVER_TOKEN'), sys.stdout))
        return
    if args.mastery_compare:
        if sys.stdout is None:
            raise RuntimeError('Use bluemilk.exe for offline comparison')
        sys.stdout.reconfigure(encoding='utf-8')
        if not getattr(sys,'frozen',False):
            sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
        from mastery_observation import compare
        try:
            before,after=(json.loads(Path(p).read_text(encoding='utf-8-sig')) for p in args.mastery_compare)
            print(json.dumps(compare(before,after,args.unit_id),ensure_ascii=False,allow_nan=False))
        except Exception as error:
            print(json.dumps({'error':str(error)},ensure_ascii=False))
            raise SystemExit(1)
        return
    if args.jsonl:
        from jsonl_cli import run_jsonl
        if sys.stdin is None or sys.stdout is None:
            raise RuntimeError('Use bluemilk.exe --jsonl with stdin/stdout')
        sys.stdin.reconfigure(encoding='utf-8');sys.stdout.reconfigure(encoding='utf-8')
        if args.server:
            from shared_cli import run_shared_jsonl
            if args.server == 'auto':
                from server_launcher import ensure_server
                endpoint = ensure_server()
                run_shared_jsonl(endpoint['uri'], endpoint['token'], sys.stdin, sys.stdout,
                                 endpoint['instance'], endpoint['pid'])
            else:
                run_shared_jsonl(args.server, os.environ.get('BLUEMILK_SERVER_TOKEN'), sys.stdin, sys.stdout)
        else:
            run_jsonl(Runtime(),sys.stdin,sys.stdout)
        return
    if args.self_test or args.probe:
        target=Path(args.self_test or args.probe)
        try:
            result={'frozen':bool(getattr(sys,'frozen',False)),'frida':frida.__version__,'assets':all((ASSETS/n).is_file() for n in MODULES+['battle_info_ui.js','bridge.js','names.json'])}
            if not result['assets']:raise RuntimeError('Missing bundled assets')
            manifest=json.loads((ASSETS/'manifest.json').read_text(encoding='utf-8'))
            result['assetHashes']={n:hashlib.sha256((ASSETS/n).read_bytes()).hexdigest() for n in MODULES+['battle_info_ui.js','bridge.js','names.json','battle_proto.js','battle_capture.js','information.bluemilk']}
            result['manifestVerified']=all(manifest['files'].get(n)==h for n,h in result['assetHashes'].items())
            if not result['manifestVerified']:raise RuntimeError('Bundled asset hash mismatch')
            if args.probe:
                runtime=Runtime();result['connection']=runtime.connect();result['cleanup']=runtime.disconnect()
            target.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        except Exception as e:target.write_text(json.dumps({'error':str(e)},ensure_ascii=False),encoding='utf-8');raise
        return
    if getattr(sys,'frozen',False) and Path(sys.executable).stem.casefold()=='bluemilk':
        parser.print_help()
        return
    kernel=ctypes.WinDLL('kernel32',use_last_error=True);kernel.CreateMutexW.restype=ctypes.c_void_p
    mutex=kernel.CreateMutexW(None,False,'Local\\SWGoHPortableTool')
    if ctypes.get_last_error()==183:
        ctypes.windll.user32.MessageBoxW(None,'工具已经运行，请使用已打开的窗口。','SWGoH 工具',0);return
    try:Window(args.ui_smoke).root.mainloop()
    finally:kernel.CloseHandle(ctypes.c_void_p(mutex))

if __name__=='__main__':main()
