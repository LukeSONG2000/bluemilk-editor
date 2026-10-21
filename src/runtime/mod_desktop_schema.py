"""Bounded, presentation-neutral desktop component declarations."""
import re


def validate(schema):
    def text(value, maximum=128):
        return type(value) is str and 0 < len(value) <= maximum
    def key(value):
        return text(value,64) and re.fullmatch(r'[a-z][a-z0-9-]*',value)
    if (type(schema) is not dict or set(schema) != {'version','query','refreshMs','features'}
            or type(schema['version']) is not int or schema['version'] != 1
            or not key(schema['query']) or type(schema['refreshMs']) is not int
            or not 1000 <= schema['refreshMs'] <= 60000
            or type(schema['features']) is not list or not 1 <= len(schema['features']) <= 32):
        raise ValueError('Invalid desktop component schema')
    seen=set()
    for feature in schema['features']:
        if (type(feature) is not dict or set(feature)-{'id','title','kind','binding','command','columns','home'}
                or not key(feature.get('id')) or feature['id'] in seen
                or not text(feature.get('title')) or feature.get('kind') not in ('toggle','button','table','text')
                or not key(feature.get('binding')) or type(feature.get('home',True)) is not bool):
            raise ValueError('Invalid desktop feature')
        seen.add(feature['id'])
        if feature['kind'] in ('toggle','button') and not key(feature.get('command')):
            raise ValueError('Interactive desktop feature requires command')
        if feature['kind']=='table':
            columns=feature.get('columns')
            if type(columns) is not list or not 1 <= len(columns) <= 8:
                raise ValueError('Desktop table requires 1–8 columns')
            names=set()
            for column in columns:
                if (type(column) is not dict or set(column)!={'key','title'} or not key(column['key'])
                        or column['key'] in names or not text(column['title'])):
                    raise ValueError('Invalid desktop table column')
                names.add(column['key'])
    return schema
