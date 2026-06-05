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
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class RedeemService {

    private final RedeemCodeMapper redeemCodeMapper;
    private final RedeemLogMapper redeemLogMapper;
    private final UserMapper userMapper;
    private final TierService tierService;

    /**
     * 兑换：只升不降。
     *   码 rank > 用户有效 rank → 升级覆盖（重置时钟）
     *   码 rank == 用户有效 rank → 同级续费（叠加天数）
     *   码 rank <  用户有效 rank → 拒绝，不消耗码
     * 过期/无会员的用户有效 rank = -1，任何码都走升级分支重新激活。
     */
    @Transactional
    public Map<String, Object> redeem(Long userId, String code) {
        RedeemCode rc = redeemCodeMapper.selectForUpdate(code);
        if (rc == null) throw new BizException(ErrorCode.REDEEM_INVALID);

        switch (rc.getStatus()) {
            case "used" -> throw new BizException(ErrorCode.REDEEM_USED);
            case "disabled" -> throw new BizException(ErrorCode.REDEEM_DISABLED);
            case "expired" -> throw new BizException(ErrorCode.REDEEM_EXPIRED);
            default -> { /* unused，继续 */ }
        }

        LocalDateTime now = LocalDateTime.now();
        if (rc.getExpireAt() != null && rc.getExpireAt().isBefore(now)) {
            rc.setStatus("expired");
            redeemCodeMapper.updateById(rc);
            throw new BizException(ErrorCode.REDEEM_EXPIRED);
        }

        String codeTier = rc.getTier();
        tierService.requireTier(codeTier);             // 码等级必须存在
        int codeRank = tierService.rankOf(codeTier);

        User user = userMapper.selectById(userId);
        boolean memberActive = user.getMemberExpireAt() != null && user.getMemberExpireAt().isAfter(now);
        // 过期 → 有效等级清空（rank=-1）
        String effectiveTier = memberActive ? user.getTier() : null;
        int userRank = tierService.rankOf(effectiveTier);

        LocalDateTime beforeExpire = user.getMemberExpireAt();
        String beforeTier = effectiveTier;
        LocalDateTime newExpire;
        String action;

        if (codeRank > userRank) {
            // 升级覆盖（试用→VIP / VIP1→VIP2 / 过期或新户首次激活）：重置时钟
            user.setTier(codeTier);
            newExpire = now.plusDays(rc.getDays());
            action = "upgrade";
        } else if (codeRank == userRank) {
            // 同级续费：天数叠加到现有到期（此分支必然 memberActive）
            user.setTier(codeTier);
            newExpire = user.getMemberExpireAt().plusDays(rc.getDays());
            action = "renew";
        } else {
            // 低等级码砸高等级用户：拒绝，事务回滚 → 码不消耗
            throw new BizException(ErrorCode.REDEEM_TIER_TOO_LOW);
        }

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
        log.setBeforeTier(beforeTier);
        log.setAfterTier(user.getTier());
        log.setAction(action);
        log.setBeforeExpireAt(beforeExpire);
        log.setAfterExpireAt(newExpire);
        redeemLogMapper.insert(log);

        Map<String, Object> data = new HashMap<>();
        data.put("days", rc.getDays());
        data.put("memberExpireAt", newExpire);
        data.put("tier", user.getTier());
        data.put("tierName", tierService.nameOf(user.getTier()));
        data.put("tierRank", tierService.rankOf(user.getTier()));
        data.put("isOfficial", tierService.isOfficial(user.getTier()));
        data.put("features", tierService.featuresObject(user.getTier()));
        data.put("action", action);
        return data;
    }

    public Map<String, Object> generateBatch(int count, int days, int validDays, String remark, String tier) {
        if (count < 1 || count > 1000) throw new BizException(ErrorCode.INVALID_PARAM, "数量须在1-1000之间");
        if (days < 1) throw new BizException(ErrorCode.INVALID_PARAM, "天数须大于0");
        tierService.requireTier(tier);                 // 等级必须存在

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
            rc.setTier(tier);
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
        data.put("tier", tier);
        data.put("tierName", tierService.nameOf(tier));
        data.put("codes", codes);
        return data;
    }

    public Page<RedeemCode> listCodes(int page, int size, String status, String batchNo) {
        LambdaQueryWrapper<RedeemCode> qw = new LambdaQueryWrapper<>();
        if (status != null && !status.isBlank()) qw.eq(RedeemCode::getStatus, status);
        if (batchNo != null && !batchNo.isBlank()) qw.eq(RedeemCode::getBatchNo, batchNo);
        qw.orderByDesc(RedeemCode::getCreatedAt);
        Page<RedeemCode> result = redeemCodeMapper.selectPage(new Page<>(page, size), qw);

        List<Long> userIds = result.getRecords().stream()
                .map(RedeemCode::getUsedBy)
                .filter(Objects::nonNull)
                .distinct()
                .toList();
        if (!userIds.isEmpty()) {
            Map<Long, String> nameMap = userMapper.selectBatchIds(userIds).stream()
                    .collect(Collectors.toMap(User::getId, User::getUsername));
            result.getRecords().forEach(rc -> {
                if (rc.getUsedBy() != null) {
                    rc.setUsedByName(nameMap.get(rc.getUsedBy()));
                }
            });
        }
        return result;
    }

    public void updateCode(Long id, Integer days, String remark) {
        RedeemCode rc = redeemCodeMapper.selectById(id);
        if (rc == null) throw new BizException(ErrorCode.REDEEM_INVALID);
        if (!"unused".equals(rc.getStatus())) throw new BizException(ErrorCode.INVALID_PARAM, "只能编辑未使用的兑换码");
        if (days != null) rc.setDays(days);
        rc.setRemark(remark);
        redeemCodeMapper.updateById(rc);
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
