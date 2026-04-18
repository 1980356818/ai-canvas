package com.aicat.server.service;

import com.aicat.server.common.BizException;
import com.aicat.server.common.ErrorCode;
import com.aicat.server.entity.UnbindLog;
import com.aicat.server.entity.UserDevice;
import com.aicat.server.mapper.UnbindLogMapper;
import com.aicat.server.mapper.UserDeviceMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class DeviceBindService {

    private final UserDeviceMapper userDeviceMapper;
    private final UnbindLogMapper unbindLogMapper;
    private final SysConfigService sysConfigService;

    public UserDevice getBound(Long userId) {
        return userDeviceMapper.selectOne(
                new LambdaQueryWrapper<UserDevice>().eq(UserDevice::getUserId, userId));
    }

    /** @return true if auto-bound (first device), false if already bound and matched */
    public boolean checkOrBind(Long userId, String machineCode, String deviceInfo, String ip) {
        UserDevice existing = getBound(userId);
        if (existing == null) {
            UserDevice d = new UserDevice();
            d.setUserId(userId);
            d.setMachineCode(machineCode);
            d.setDeviceInfo(deviceInfo);
            d.setBoundAt(LocalDateTime.now());
            d.setBoundIp(ip);
            userDeviceMapper.insert(d);
            return true;
        }
        if (existing.getMachineCode().equals(machineCode)) {
            return false;
        }
        throw new BizException(ErrorCode.DEVICE_MISMATCH);
    }

    @Transactional
    public void unbindAndRebind(Long userId, String newMachineCode, String deviceInfo, String ip, String operator) {
        if ("user".equals(operator)) {
            int limit = sysConfigService.getInt("unbind_limit_per_month", 1);
            int used = unbindLogMapper.countThisMonth(userId);
            if (used >= limit) {
                throw new BizException(ErrorCode.UNBIND_LIMIT);
            }
        }

        UserDevice existing = getBound(userId);
        String oldCode = existing != null ? existing.getMachineCode() : "";

        if (existing != null) {
            userDeviceMapper.deleteById(existing.getId());
        }

        UserDevice d = new UserDevice();
        d.setUserId(userId);
        d.setMachineCode(newMachineCode);
        d.setDeviceInfo(deviceInfo);
        d.setBoundAt(LocalDateTime.now());
        d.setBoundIp(ip);
        userDeviceMapper.insert(d);

        UnbindLog log = new UnbindLog();
        log.setUserId(userId);
        log.setOldMachineCode(oldCode);
        log.setNewMachineCode(newMachineCode);
        log.setIp(ip);
        log.setOperator(operator);
        unbindLogMapper.insert(log);
    }

    public Map<String, Object> getDeviceInfo(Long userId) {
        UserDevice dev = getBound(userId);
        int limit = sysConfigService.getInt("unbind_limit_per_month", 1);
        int used = unbindLogMapper.countThisMonth(userId);

        Map<String, Object> info = new HashMap<>();
        info.put("bound", dev != null);
        info.put("machineCode", dev != null ? maskCode(dev.getMachineCode()) : null);
        info.put("deviceInfo", dev != null ? dev.getDeviceInfo() : null);
        info.put("boundAt", dev != null ? dev.getBoundAt() : null);
        info.put("unbindLimit", limit);
        info.put("unbindUsed", used);
        info.put("unbindRemaining", Math.max(0, limit - used));
        return info;
    }

    private String maskCode(String code) {
        if (code == null || code.length() <= 12) return code;
        return code.substring(0, 8) + "****" + code.substring(code.length() - 4);
    }
}
