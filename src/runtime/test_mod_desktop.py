import copy
import io
import json
import subprocess
import unittest
import zipfile
from unittest.mock import Mock
from types import SimpleNamespace
from mod_desktop_schema import validate
from mod_modules import bundle
from runtime_protocol import ProtocolSession


class DesktopTests(unittest.TestCase):
    def schema(self):
        return {'version':1,'query':'view','refreshMs':1000,'features':[
            {'id':'sample','title':'Sample','kind':'toggle','binding':'sample','command':'set-sample','home':True}]}

    def test_generic_schema_rejects_unbounded_or_executable_bindings(self):
        self.assertEqual(validate(self.schema())['query'],'view')
        for field,value in [('refreshMs',10),('query','run();'),('version',2)]:
            data=self.schema();data[field]=value
            with self.assertRaises(ValueError):validate(data)
        for field,value in [('binding','__proto__.sample'),('home','yes'),('kind','webview'),('command','')]:
            data=self.schema();data['features'][0][field]=value
            with self.assertRaises(ValueError):validate(data)
        data=self.schema();data['features']*=2
        with self.assertRaises(ValueError):validate(data)

    def test_package_modules_resolve_only_inside_verified_inventory(self):
        files={'main.js':"module.exports=require('./lib/value')+require('./data.json').value;",
               'lib/value.js':"module.exports=7;",'data.json':'{"value":9}'}
        memory=io.BytesIO()
        with zipfile.ZipFile(memory,'w') as z:
            for name,value in files.items():z.writestr(name,value)
        with zipfile.ZipFile(memory) as z:source=bundle(z,{'entry':'main.js','files':files})
        result=subprocess.run(['node','-e',"const m={exports:{}};new Function('module','exports',"+json.dumps(source)+")(m,m.exports);console.log(m.exports)"],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout.strip(),'16')

    def test_queries_require_enabled_declared_query_and_cannot_dispatch_game_actions(self):
        manifest={'id':'org.example.sample','desktop':self.schema()}
        runtime=SimpleNamespace(call_args=Mock(side_effect=lambda op,*a:
            {'mods':[{'manifest':manifest,'state':'enabled'}]} if op=='modcommand' else {'sample':True}))
        session=ProtocolSession(runtime)
        def query(command):return session.dispatch(json.dumps({'id':command,'operation':'mods-query','payload':{'id':manifest['id'],'command':command,'payload':{}}}))
        self.assertTrue(query('view')['ok']);self.assertFalse(query('set-sample')['ok'])
        runtime.call_args.side_effect=lambda op,*a: {'mods':[{'manifest':manifest,'state':'enabled'}]} if op=='modcommand' else {'blueMilkHostOperation':1}
        self.assertFalse(query('view')['ok'])
