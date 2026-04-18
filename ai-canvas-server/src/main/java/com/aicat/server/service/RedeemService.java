package com.aicat.server.service;

import com.aicat.server.common.BizException;
import com.aicat.server.common.ErrorCode;
import com.aicat.server.entity.RedeemCode;
import com.aicat.server.entity.RedeemLog;
import com.aicat.server.entity.User;
import com.aicat.server.mapper.RedeemCodeMapper;
import com.aicat.server.mapper.RedeemLogMapper;
import com.aicat.server.mapper.UserMapper;
import com.aicat.server.util.RedeemCodeGenerator;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;

@Service
@RequiredArgsConstructor
public class RedeemService {

    private final RedeemCodeMapper redeemCodeMapper;
    private final RedeemLogMapper redeemLogMapper;
    private final UserMapper userMapper;

    @Transactional
    public Map<String, Object> redeem(Long userId, String code) {
        RedeemCode rc = redeemCodeMapper.selectForUpdate(code);
        if (rc == null) throw new BizException(ErrorCode.REDEEM_INVALID);

        return switch (rc.getStatus()) {
            case "used" -> throw new BizException(ErrorCode.REDEEM_USED);
            case "disabled" -> throw new BizException(ErrorCode.REDEEM_DISABLED);
            case "expired" -> throw new BizException(ErrorCode.REDEEM_EXPIRED);
            default -> {
                if (rc.getExpireAt() != null && rc.getExpireAt().isBefore(LocalDateTime.now())) {
                    rc.setStatus("expired");
                    redeemCodeMapper.updateById(rc);
                    throw new BizException(ErrorCode.REDEEM_EXPIRED);
                }

                User user = userMapper.selectById(userId);
                LocalDateTime now = LocalDateTime.now();
                LocalDateTime base = (user.getMemberExpireAt() != null && user.getMemberExpireAt().isAfter(now))
                        ? user.getMemberExpireAt() : now;
                LocalDateTime newExpire = base.plusDays(rc.getDays());

                LocalDateTime beforeExpire = user.getMemberExpireAt();
                user.setMemberExpireAt(newExpire);
                userMapper.updateById(user);

                rc.setStatus("used");
                rc.setUsedBy(userId);
                rc.setUsedAt(now);
                redeemCodeMapper.updateById(rc);

                RedeemLog log = new RedeemLog();
                log.setUserId(userId);
                log.setRedeemCodeId(rc.getId());
                log.setCode(rc.getCode());
                log.setDays(rc.getDays());
                log.setBeforeExpireAt(beforeExpire);
                log.setAfterExpireAt(newExpire);
                redeemLogMapper.insert(log);

                Map<String, Object> data = new HashMap<>();
                data.put("days", rc.getDays());
                data.put("memberExpireAt", newExpire);
                yield data;
            }
        };
    }

    public Map<String, Object> generateBatch(int count, int days, int validDays, String remark) {
        if (count < 1 || count > 1000) throw new BizException(ErrorCode.INVALID_PARAM, "数量须在1-1000之间");
        if (days < 1) throw new BizException(ErrorCode.INVALID_PARAM, "天数须大于0");

        String batchNo = "B" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMddHHmmss"));
        LocalDateTime expireAt = validDays > 0 ? LocalDateTime.now().plusDays(validDays) : null;

        List<String> codes = new ArrayList<>(count);
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < count; i++) {
            String code;
            do { code = RedeemCodeGenerator.generate(); } while (!seen.add(code));

            RedeemCode rc = new RedeemCode();
            rc.setCode(code);
            rc.setDays(days);
            rc.setStatus("unused");
            rc.setBatchNo(batchNo);
            rc.setExpireAt(expireAt);
            rc.setRemark(remark);
            redeemCodeMapper.insert(rc);
            codes.add(code);
        }

        Map<String, Object> data = new HashMap<>();
        data.put("batchNo", batchNo);
        data.put("count", count);
        data.put("days", days);
        data.put("codes", codes);
        return data;
    }

    public Page<RedeemCode> listCodes(int page, int size, String status, String batchNo) {
        LambdaQueryWrapper<RedeemCode> qw = new LambdaQueryWrapper<>();
        if (status != null && !status.isBlank()) qw.eq(RedeemCode::getStatus, status);
        if (batchNo != null && !batchNo.isBlank()) qw.eq(RedeemCode::getBatchNo, batchNo);
        qw.orderByDesc(RedeemCode::getCreatedAt);
        return redeemCodeMapper.selectPage(new Page<>(page, size), qw);
    }

    public void disableCode(Long id) {
        RedeemCode rc = redeemCodeMapper.selectById(id);
        if (rc == null) throw new BizException(ErrorCode.REDEEM_INVALID);
        if (!"unused".equals(rc.getStatus())) throw new BizException(ErrorCode.INVALID_PARAM, "只能禁用未使用的兑换码");
        rc.setStatus("disabled");
        redeemCodeMapper.updateById(rc);
    }

    public Page<RedeemLog> listUserRedeemLogs(Long userId, int page, int size) {
        return redeemLogMapper.selectPage(new Page<>(page, size),
                new LambdaQueryWrapper<RedeemLog>().eq(RedeemLog::getUserId, userId)
                        .orderByDesc(RedeemLog::getCreatedAt));
    }

    public Map<String, Object> codeStats() {
        Map<String, Object> stats = new HashMap<>();
        stats.put("total", redeemCodeMapper.selectCount(null));
        stats.put("unused", redeemCodeMapper.selectCount(new LambdaQueryWrapper<RedeemCode>().eq(RedeemCode::getStatus, "unused")));
        stats.put("used", redeemCodeMapper.selectCount(new LambdaQueryWrapper<RedeemCode>().eq(RedeemCode::getStatus, "used")));
        stats.put("disabled", redeemCodeMapper.selectCount(new LambdaQueryWrapper<RedeemCode>().eq(RedeemCode::getStatus, "disabled")));
        stats.put("expired", redeemCodeMapper.selectCount(new LambdaQueryWrapper<RedeemCode>().eq(RedeemCode::getStatus, "expired")));
        return stats;
    }
}
