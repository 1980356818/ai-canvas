package com.aicat.server.service;

import com.aicat.server.common.BizException;
import com.aicat.server.common.ErrorCode;
import com.aicat.server.entity.TemplateCategory;
import com.aicat.server.mapper.TemplateCategoryMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * 模板分组（注册表）查询/管理。照抄 {@link TemplateService} 风格。
 */
@Service
@RequiredArgsConstructor
public class TemplateCategoryService {

    private final TemplateCategoryMapper mapper;

    /** 客户端:全部上架分组,按 sort 升序。 */
    public List<TemplateCategory> listActive() {
        return mapper.selectList(new LambdaQueryWrapper<TemplateCategory>()
                .eq(TemplateCategory::getIsActive, 1)
                .orderByAsc(TemplateCategory::getSort));
    }

    /** admin:全部分组（含下架）,按 sort 升序。 */
    public List<TemplateCategory> listAll() {
        return mapper.selectList(new LambdaQueryWrapper<TemplateCategory>()
                .orderByAsc(TemplateCategory::getSort));
    }

    /** 业务键 upsert：存在则更新,否则插入。 */
    public void upsert(TemplateCategory c) {
        if (mapper.selectById(c.getCatKey()) != null) {
            mapper.updateById(c);
        } else {
            mapper.insert(c);
        }
    }

    /** 只改元信息（label/sort/minAppVersion）,不动 key。供 admin 编辑用。 */
    public void updateMeta(String key, String label, Integer sort, String minAppVersion) {
        TemplateCategory c = mapper.selectById(key);
        if (c == null) throw new BizException(ErrorCode.TEMPLATE_CATEGORY_NOT_FOUND);
        if (label != null && !label.isBlank()) c.setLabel(label);
        if (sort != null) c.setSort(sort);
        c.setMinAppVersion(minAppVersion);
        mapper.updateById(c);
    }

    public void setActive(String key, boolean active) {
        TemplateCategory c = mapper.selectById(key);
        if (c == null) throw new BizException(ErrorCode.TEMPLATE_CATEGORY_NOT_FOUND);
        c.setIsActive(active ? 1 : 0);
        mapper.updateById(c);
    }

    public void delete(String key) {
        mapper.deleteById(key);
    }

    /** admin 拖拽重排：按完整有序 key 列表重新赋 sort=0..N（MP 默认只更非 null → 只写 sort 列）。一个事务。 */
    @Transactional
    public void reorder(List<String> keys) {
        if (keys == null) return;
        for (int i = 0; i < keys.size(); i++) {
            TemplateCategory c = new TemplateCategory();
            c.setCatKey(keys.get(i));
            c.setSort(i);
            mapper.updateById(c);
        }
    }
}
