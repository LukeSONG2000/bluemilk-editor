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
        if (type(feature) is not dict or set(feature)-{'id','title','description','kind','binding','command','columns','home','options','floating'}
                or not key(feature.get('id')) or feature['id'] in seen
                or not text(feature.get('title')) or feature.get('kind') not in ('toggle','button','table','text','select')
                or not key(feature.get('binding')) or type(feature.get('home',True)) is not bool):
            raise ValueError('Invalid desktop feature')
        seen.add(feature['id'])
        if 'description' in feature and not text(feature['description'],512):
            raise ValueError('Invalid desktop feature description')
        if feature['kind'] in ('toggle','button','select') and not key(feature.get('command')):
            raise ValueError('Interactive desktop feature requires command')
        if feature['kind']=='select':
            options=feature.get('options')
            if (type(options) is not list or not 1 <= len(options) <= 16
                    or any(type(o) is not dict or set(o)!={'value','label'} or not key(o['value']) or not text(o['label']) for o in options)
                    or len({o['value'] for o in options})!=len(options)):
                raise ValueError('Invalid desktop selection options')
        if 'floating' in feature:
            theme=feature['floating']
            if (feature['kind']!='table' or type(theme) is not dict
                    or not {'background','foreground','border','fontFamily','fontSize'} <= set(theme)
                    or set(theme)-{'background','foreground','border','fontFamily','fontSize','fontAsset','spriteAsset'}
                    or any(type(theme[c]) is not str or not re.fullmatch(r'#[0-9A-Fa-f]{8}',theme[c]) for c in ('background','foreground','border'))
                    or not text(theme['fontFamily'],128) or type(theme['fontSize']) is not int or not 12<=theme['fontSize']<=24):
                raise ValueError('Invalid floating component theme')
            if 'fontAsset' in theme and (type(theme['fontAsset']) is not str or not re.fullmatch(r'[A-Za-z0-9_ -]{1,96}',theme['fontAsset'])):
                raise ValueError('Invalid original font family')
            if 'spriteAsset' in theme and (type(theme['spriteAsset']) is not str or not re.fullmatch(r'[A-Za-z0-9_-]{1,96}',theme['spriteAsset'])):
                raise ValueError('Invalid original sprite name')
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
