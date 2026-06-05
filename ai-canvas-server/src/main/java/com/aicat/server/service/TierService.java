package com.aicat.server.service;

import com.aicat.server.common.BizException;
import com.aicat.server.common.ErrorCode;
import com.aicat.server.entity.TierDef;
import com.aicat.server.mapper.TierDefMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 会员等级（tier_def）查询 + 管理。
 * - rank 比较是"只升不降"算法的地基（{@link #rankOf}）。
 * - features 以 JSON 字符串存库，对外解析成对象下发给客户端做功能门禁。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class TierService {

    private final TierDefMapper tierDefMapper;
    private final ObjectMapper objectMapper;

    /** 无等级 / 未找到 / 已过期清空 统一用这个 rank，保证任何有效码都能覆盖它。 */
    public static final int RANK_NONE = -1;

    public TierDef getByKey(String tierKey) {
        if (tierKey == null || tierKey.isBlank()) return null;
        return tierDefMapper.selectOne(
                new LambdaQueryWrapper<TierDef>().eq(TierDef::getTierKey, tierKey));
    }

    /** 等级 rank。key 为 null / 不存在 → RANK_NONE(-1)。调用方传入的应是"有效等级"（过期请传 null）。 */
    public int rankOf(String tierKey) {
        TierDef t = getByKey(tierKey);
        return t != null && t.getTierRank() != null ? t.getTierRank() : RANK_NONE;
    }

    public boolean exists(String tierKey) {
        return getByKey(tierKey) != null;
    }

    /** 校验等级存在，否则抛错（生成码 / 设置用户等级时用）。 */
    public TierDef requireTier(String tierKey) {
        TierDef t = getByKey(tierKey);
        if (t == null) throw new BizException(ErrorCode.TIER_NOT_FOUND);
        return t;
    }

    public String nameOf(String tierKey) {
        TierDef t = getByKey(tierKey);
        return t != null ? t.getName() : null;
    }

    public boolean isOfficial(String tierKey) {
        TierDef t = getByKey(tierKey);
        return t != null && t.getIsOfficial() != null && t.getIsOfficial() == 1;
    }

    /** 把 features JSON 字符串解析成对象下发客户端。key 为 null / 解析失败 → 空对象。 */
    public Object featuresObject(String tierKey) {
        TierDef t = getByKey(tierKey);
        if (t == null || t.getFeatures() == null || t.getFeatures().isBlank()) {
            return Collections.emptyMap();
        }
        try {
            return objectMapper.readValue(t.getFeatures(), Map.class);
        } catch (Exception e) {
            log.warn("tier_def.features 解析失败 tierKey={} : {}", tierKey, e.getMessage());
            return Collections.emptyMap();
        }
    }

    // ───────────── 后台管理 ─────────────

    /** 全部等级（含停用），按 sort、rank 排序，供后台列表 / 生成码下拉。 */
    public List<TierDef> listAll() {
        return tierDefMapper.selectList(
                new LambdaQueryWrapper<TierDef>()
                        .orderByAsc(TierDef::getSort)
                        .orderByAsc(TierDef::getTierRank));
    }

    public TierDef create(TierDef req) {
        validateFeaturesJson(req.getFeatures());
        if (getByKey(req.getTierKey()) != null) {
            throw new BizException(ErrorCode.INVALID_PARAM, "等级标识已存在");
        }
        if (req.getIsActive() == null) req.setIsActive(1);
        if (req.getIsOfficial() == null) req.setIsOfficial(req.getTierRank() != null && req.getTierRank() >= 10 ? 1 : 0);
        if (req.getSort() == null) req.setSort(0);
        req.setId(null);
        tierDefMapper.insert(req);
        return req;
    }

    public void update(Long id, TierDef req) {
        TierDef existing = tierDefMapper.selectById(id);
        if (existing == null) throw new BizException(ErrorCode.TIER_NOT_FOUND);
        if (req.getFeatures() != null) validateFeaturesJson(req.getFeatures());
        // tier_key 不允许改（用户/码都引用它），其余可改
        if (req.getName() != null) existing.setName(req.getName());
        if (req.getTierRank() != null) existing.setTierRank(req.getTierRank());
        if (req.getIsOfficial() != null) existing.setIsOfficial(req.getIsOfficial());
        if (req.getFeatures() != null) existing.setFeatures(req.getFeatures());
        if (req.getIsActive() != null) existing.setIsActive(req.getIsActive());
        if (req.getSort() != null) existing.setSort(req.getSort());
        tierDefMapper.updateById(existing);
    }

    public void setActive(Long id, int active) {
        TierDef existing = tierDefMapper.selectById(id);
        if (existing == null) throw new BizException(ErrorCode.TIER_NOT_FOUND);
        existing.setIsActive(active);
        tierDefMapper.updateById(existing);
    }

    private void validateFeaturesJson(String features) {
        if (features == null || features.isBlank()) {
            throw new BizException(ErrorCode.INVALID_PARAM, "features 不能为空");
        }
        try {
            objectMapper.readValue(features, LinkedHashMap.class);
        } catch (Exception e) {
            throw new BizException(ErrorCode.INVALID_PARAM, "features 不是合法 JSON 对象");
        }
    }
}
