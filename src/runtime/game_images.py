"""Cache bounded original sprite readbacks locally; no redistributed assets."""
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import zlib


def cache_sprite(record, expected, root=None, profile=None):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,96}', expected) or record.get('name') != expected:
        raise ValueError('Original sprite identity mismatch')
    w,h=record.get('width'),record.get('height')
    if type(w) is not int or type(h) is not int or not 1<=w<=512 or not 1<=h<=512:
        raise ValueError('Original sprite dimensions exceed bounds')
    rgba,nine=record.get('rgba'),record.get('nineGrid')
    if type(rgba) is not list or len(rgba)!=w*h*4 or any(type(n) is not int or not 0<=n<=255 for n in rgba):
        raise ValueError('Invalid original pixel data')
    if (type(nine) is not list or len(nine)!=4 or any(type(n) is not int or n<0 for n in nine)
            or nine[0]+nine[2]>w or nine[1]+nine[3]>h or type(record.get('bottomUp')) is not bool):
        raise ValueError('Invalid original nine-slice geometry')
    rows=[bytes(rgba[i*w*4:(i+1)*w*4]) for i in range(h)]
    if record['bottomUp']:rows.reverse()
    def chunk(tag,blob):return struct.pack('>I',len(blob))+tag+blob+struct.pack('>I',zlib.crc32(tag+blob)&0xffffffff)
    image=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))
    image+=chunk(b'IDAT',zlib.compress(b''.join(b'\0'+row for row in rows)))+chunk(b'IEND',b'')
    digest=hashlib.sha256(image).hexdigest()
    folder=Path(root) if root else Path(os.environ['USERPROFILE'])/'.bluemilk'/'image-cache'
    folder.mkdir(parents=True,exist_ok=True);output=folder/(digest+'.png')
    if not output.exists() or hashlib.sha256(output.read_bytes()).hexdigest()!=digest:
        temporary=output.with_suffix('.tmp');temporary.write_bytes(image);temporary.replace(output)
    result={'path':str(output.resolve()),'sha256':digest,'name':expected,'nineGrid':nine,'bytes':len(image),'source':'local-original-game'}
    if profile:
        key=hashlib.sha256((profile+'\0'+expected).encode()).hexdigest()
        target=folder/(key+'.json');temporary=target.with_suffix('.tmp')
        temporary.write_text(json.dumps({'profile':profile,'image':result}),'utf8');temporary.replace(target)
    return result


def cached_sprite(name,profile,root=None):
    folder=Path(root) if root else Path(os.environ['USERPROFILE'])/'.bluemilk'/'image-cache'
    key=hashlib.sha256((profile+'\0'+name).encode()).hexdigest()
    try:
        record=json.loads((folder/(key+'.json')).read_text('utf8'));image=record['image']
        path=Path(image['path'])
        if record['profile']!=profile or image['name']!=name or image['source']!='local-original-game':return None
        if not path.is_absolute() or path.parent.resolve()!=folder.resolve() or path.stat().st_size>2*1024*1024:return None
        data=path.read_bytes()
        if hashlib.sha256(data).hexdigest()!=image['sha256'] or data[:8]!=b'\x89PNG\r\n\x1a\n':return None
        w,h=struct.unpack_from('>II',data,16);nine=image['nineGrid']
        if len(nine)!=4 or any(type(n) is not int or n<0 for n in nine) or nine[0]+nine[2]>w or nine[1]+nine[3]>h:return None
        return image
    except (OSError,ValueError,KeyError,TypeError,struct.error):return None
