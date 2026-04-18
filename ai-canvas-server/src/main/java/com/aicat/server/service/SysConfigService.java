package com.aicat.server.service;

import com.aicat.server.entity.SysConfig;
import com.aicat.server.mapper.SysConfigMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Service
@RequiredArgsConstructor
public class SysConfigService {

    private final SysConfigMapper sysConfigMapper;
    private final ConcurrentHashMap<String, String> cache = new ConcurrentHashMap<>();

    public String get(String key, String defaultVal) {
        String v = cache.get(key);
        if (v != null) return v;
        SysConfig c = sysConfigMapper.selectOne(
                new LambdaQueryWrapper<SysConfig>().eq(SysConfig::getConfigKey, key));
        if (c != null) {
            cache.put(key, c.getConfigVal());
            return c.getConfigVal();
        }
        return defaultVal;
    }

    public int getInt(String key, int defaultVal) {
        try {
            return Integer.parseInt(get(key, String.valueOf(defaultVal)));
        } catch (NumberFormatException e) {
            return defaultVal;
        }
    }

    public void set(String key, String val) {
        SysConfig c = sysConfigMapper.selectOne(
                new LambdaQueryWrapper<SysConfig>().eq(SysConfig::getConfigKey, key));
        if (c != null) {
            c.setConfigVal(val);
            sysConfigMapper.updateById(c);
        } else {
            c = new SysConfig();
            c.setConfigKey(key);
            c.setConfigVal(val);
            sysConfigMapper.insert(c);
        }
        cache.put(key, val);
    }

    public void evict(String key) {
        cache.remove(key);
    }

    public List<SysConfig> listAll() {
        return sysConfigMapper.selectList(null);
    }

    public Map<String, String> allAsMap() {
        Map<String, String> m = new java.util.LinkedHashMap<>();
        listAll().forEach(c -> m.put(c.getConfigKey(), c.getConfigVal()));
        return m;
    }
}
