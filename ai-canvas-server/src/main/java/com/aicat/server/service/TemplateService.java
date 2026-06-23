package com.aicat.server.service;

import com.aicat.server.common.BizException;
import com.aicat.server.common.ErrorCode;
import com.aicat.server.entity.Template;
import com.aicat.server.mapper.TemplateMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;;

/**
 * 模板查询/管理。复用 AppReleaseService.encodeVersion 做版本守卫。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class TemplateService {

    private final TemplateMapper mapper;
    private final ObjectMapper objectMapper;
    private final TierService tierService;

    /**
     * 客户端:全部上架模板按 sort 升序,返回解析后的 definition(整个 WorkflowTemplate JSON)。
     * appVersion 非空时,过滤掉 min_app_version 高于客户端的模板(版本守卫)。
     * tier 非空时,按该等级的 templateCategories 过滤(只下发有权分类);
     * tier 为 null(匿名 / 旧客户端)或 templates="*" 的 VIP → 全量下发。
     */
    public List<JsonNode> listForClient(String appVersion, String tier) {
        Set<String> allowedCategories = resolveAllowedCategories(tier);

        List<Template> rows = mapper.selectList(new LambdaQueryWrapper<Template>()
                .eq(Template::getIsActive, 1)
                .orderByAsc(Template::getSort));
        List<JsonNode> out = new ArrayList<>(rows.size());
        for (Template t : rows) {
            if (!versionAllows(appVersion, t.getMinAppVersion())) continue;
            if (allowedCategories != null && !allowedCategories.contains(t.getCategory())) continue;
            try {
                JsonNode node = objectMapper.readTree(t.getDefinition());
                if (node.isObject() && t.getCategory() != null && !t.getCategory().isBlank()) {
                    ((ObjectNode) node).put("category", t.getCategory());
                }
                out.add(node);
            } catch (Exception e) {
                log.warn("template {} definition 解析失败,跳过: {}", t.getId(), e.getMessage());
            }
        }
        return out;
    }

    /**
     * 解析等级允许的模板分类。null = 全量(不过滤)。
     * templates="*" 或无 templateCategories → null(全量);
     * 有 templateCategories → 返回允许的分类集合。
     */
    @SuppressWarnings("unchecked")
    private Set<String> resolveAllowedCategories(String tier) {
        if (tier == null || tier.isBlank()) return null;
        Object features = tierService.featuresObject(tier);
        if (!(features instanceof Map)) return null;
        Map<String, Object> map = (Map<String, Object>) features;
        Object templates = map.get("templates");
        if ("*".equals(templates)) return null;
        Object cats = map.get("templateCategories");
        if (cats instanceof List<?> list && !list.isEmpty()) {
            Set<String> set = new HashSet<>(list.size());
            for (Object c : list) set.add(String.valueOf(c));
            return set;
        }
        return null;
    }

    /**
     * admin 列表：排除巨型 definition 列（列表用不到它），避免无 WHERE 的 ORDER BY sort 把大行
     * 塞进 filesort 触发 ERROR 1038 Out of sort memory。
     */
    public List<Template> listAll() {
        return mapper.selectList(new LambdaQueryWrapper<Template>()
                .select(Template.class, i -> !"definition".equals(i.getColumn()))
                .orderByAsc(Template::getSort));
    }

    /** 业务键 upsert:存在则更新,否则插入。 */
    public void upsert(Template t) {
        if (mapper.selectById(t.getId()) != null) {
            mapper.updateById(t);
        } else {
            mapper.insert(t);
        }
    }

    public void setActive(String id, boolean active) {
        Template t = mapper.selectById(id);
        if (t == null) throw new BizException(ErrorCode.TEMPLATE_NOT_FOUND);
        t.setIsActive(active ? 1 : 0);
        mapper.updateById(t);
    }

    public void delete(String id) {
        mapper.deleteById(id);
    }

    /** admin 拖拽重排：按完整有序 id 列表重新赋 sort=0..N（MP 默认只更非 null → 只写 sort 列）。一个事务。 */
    @Transactional
    public void reorder(List<String> ids) {
        if (ids == null) return;
        for (int i = 0; i < ids.size(); i++) {
            Template t = new Template();
            t.setId(ids.get(i));
            t.setSort(i);
            mapper.updateById(t);
        }
    }

    /** 只改元信息(不动 definition)。供 admin 编辑用。 */
    public void updateMeta(String id, String name, String description, String category,
                           String minAppVersion, Integer sort) {
        Template t = mapper.selectById(id);
        if (t == null) throw new BizException(ErrorCode.TEMPLATE_NOT_FOUND);
        if (name != null && !name.isBlank()) t.setName(name);
        t.setDescription(description);
        t.setCategory(category);
        t.setMinAppVersion(minAppVersion);
        if (sort != null) t.setSort(sort);
        mapper.updateById(t);
    }

    /** 客户端版本 ≥ 模板 min_app_version 才下发。任一解析不了就放行(宁可显示也别误伤)。 */
    private static boolean versionAllows(String appVersion, String minAppVersion) {
        if (minAppVersion == null || minAppVersion.isBlank()) return true;
        if (appVersion == null || appVersion.isBlank()) return true;
        try {
            return AppReleaseService.encodeVersion(appVersion) >= AppReleaseService.encodeVersion(minAppVersion);
        } catch (Exception e) {
            return true;
        }
    }
}
